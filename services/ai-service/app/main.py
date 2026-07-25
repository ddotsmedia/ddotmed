from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .coding import CodingService
from .config import get_settings
from .gateway import ModelGateway, ProviderError
from .predictors import predict_denial, predict_no_show
from .rag import RagService
from .schemas import (
    CodingSuggestRequest,
    CodingSuggestResponse,
    DenialPredictRequest,
    DenialPredictResponse,
    NoShowRiskRequest,
    NoShowRiskResponse,
    ScribeFinaliseRequest,
    ScribeFinaliseResponse,
    ScribeStartRequest,
    ScribeStartResponse,
    SearchRequest,
    SearchResponse,
    VoiceAgentSessionRequest,
    VoiceAgentSessionResponse,
    VoiceAgentTurnRequest,
    VoiceAgentTurnResponse,
)
from .scribe import ScribeService
from .voice_agent import VoiceAgentService

structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger(__name__)

gateway = ModelGateway()
scribe_service = ScribeService(gateway)
coding_service = CodingService(gateway)
voice_service = VoiceAgentService(gateway)
rag_service = RagService()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level)
    log.info("ai-service.start", provider=settings.ai_model_gateway, port=settings.port)
    yield
    log.info("ai-service.stop")


app = FastAPI(
    title="MediCore AI Service",
    version="1.0.0",
    description="Ambient scribe, coding assistant, denial prediction, RAG search and voice front desk",
    lifespan=lifespan,
)


class Principal:
    """Identity extracted from the core-api RS256 token."""

    def __init__(self, tenant_id: str, user_id: str | None) -> None:
        self.tenant_id = tenant_id
        self.user_id = user_id


async def current_principal(
    authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    """Verifies the bearer token. Without a configured public key the service refuses PHI work."""
    settings = get_settings()
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    if not settings.jwt_public_key:
        raise HTTPException(
            status_code=503,
            detail="JWT_PUBLIC_KEY is not configured; the AI service cannot verify callers",
        )

    from jose import JWTError, jwt

    try:
        claims = jwt.decode(
            token,
            settings.jwt_public_key.replace("\\n", "\n"),
            algorithms=["RS256"],
            issuer=settings.jwt_issuer,
            audience=settings.jwt_audience,
        )
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc

    tenant_id = claims.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Token carries no tenant")
    return Principal(tenant_id=tenant_id, user_id=claims.get("sub"))


@app.exception_handler(ProviderError)
async def provider_error_handler(_: Request, exc: ProviderError) -> JSONResponse:
    log.error("ai.provider.failed", error=str(exc))
    return JSONResponse(status_code=502, content={"detail": str(exc), "code": "PROVIDER_UNAVAILABLE"})


@app.get("/health")
async def health() -> dict[str, Any]:
    settings = get_settings()
    return {
        "status": "ok",
        "service": "ai-service",
        "version": "1.0.0",
        "provider": settings.ai_model_gateway,
        "confidence_threshold": settings.confidence_threshold,
    }


# ── Ambient scribe ────────────────────────────────────────────────────────────


@app.post("/scribe/start", response_model=ScribeStartResponse)
async def scribe_start(
    req: ScribeStartRequest,
    request: Request,
    principal: Annotated[Principal, Depends(current_principal)],
) -> ScribeStartResponse:
    if not req.consent_obtained:
        raise HTTPException(
            status_code=400,
            detail="Patient consent must be recorded before ambient recording starts",
        )
    base = str(request.base_url).rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
    return await scribe_service.start(
        patient_id=req.patient_id,
        encounter_id=req.encounter_id,
        language=req.language,
        consent_obtained=req.consent_obtained,
        user_id=principal.user_id,
        base_url=base,
    )


@app.websocket("/scribe/stream")
async def scribe_stream(websocket: WebSocket, session_id: str) -> None:
    """Receives raw PCM s16le mono @16 kHz and acknowledges accumulated duration."""
    await websocket.accept()
    try:
        while True:
            chunk = await websocket.receive_bytes()
            duration_ms = await scribe_service.append_audio(session_id, chunk)
            await websocket.send_json({"type": "ack", "duration_ms": duration_ms})
    except WebSocketDisconnect:
        log.info("scribe.stream.disconnect", session_id=session_id)
    except (KeyError, ValueError) as exc:
        await websocket.send_json({"type": "error", "detail": str(exc)})
        await websocket.close(code=1008)


@app.post("/scribe/finalise", response_model=ScribeFinaliseResponse)
async def scribe_finalise(
    req: ScribeFinaliseRequest,
    _: Annotated[Principal, Depends(current_principal)],
) -> ScribeFinaliseResponse:
    try:
        return await scribe_service.finalise(req.session_id, req.language)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ── Coding assistant ──────────────────────────────────────────────────────────


@app.post("/coding/suggest", response_model=CodingSuggestResponse)
async def coding_suggest(
    req: CodingSuggestRequest,
    principal: Annotated[Principal, Depends(current_principal)],
) -> CodingSuggestResponse:
    return await coding_service.suggest(req, user_id=principal.user_id)


# ── Risk prediction ───────────────────────────────────────────────────────────


@app.post("/denial/predict", response_model=DenialPredictResponse)
async def denial_predict(
    req: DenialPredictRequest,
    _: Annotated[Principal, Depends(current_principal)],
) -> DenialPredictResponse:
    return predict_denial(req)


@app.post("/appointments/noshow-risk", response_model=NoShowRiskResponse)
async def noshow_risk(
    req: NoShowRiskRequest,
    _: Annotated[Principal, Depends(current_principal)],
) -> NoShowRiskResponse:
    return predict_no_show(req)


# ── RAG search ────────────────────────────────────────────────────────────────


@app.post("/search", response_model=SearchResponse)
async def search(
    req: SearchRequest,
    principal: Annotated[Principal, Depends(current_principal)],
) -> SearchResponse:
    return await rag_service.search(principal.tenant_id, req)


@app.post("/search/index")
async def index_resource(
    body: dict[str, Any],
    principal: Annotated[Principal, Depends(current_principal)],
) -> dict[str, str]:
    await rag_service.index_resource(
        tenant_id=principal.tenant_id,
        patient_id=body.get("patient_id"),
        resource_type=body["resource_type"],
        resource_id=body["resource_id"],
        resource=body["resource"],
        recorded_at=body.get("recorded_at"),
    )
    return {"status": "indexed"}


# ── Voice front desk ──────────────────────────────────────────────────────────


@app.post("/voice-agent/session", response_model=VoiceAgentSessionResponse)
async def voice_session(
    req: VoiceAgentSessionRequest,
    request: Request,
    _: Annotated[Principal, Depends(current_principal)],
) -> VoiceAgentSessionResponse:
    base = str(request.base_url).rstrip("/").replace("http://", "ws://").replace("https://", "wss://")
    return voice_service.start(
        caller_number=req.caller_number,
        tenant_slug=req.tenant_slug,
        language=req.language,
        base_url=base,
    )


@app.post("/voice-agent/turn", response_model=VoiceAgentTurnResponse)
async def voice_turn(
    req: VoiceAgentTurnRequest,
    _: Annotated[Principal, Depends(current_principal)],
) -> VoiceAgentTurnResponse:
    try:
        return await voice_service.turn(req.session_id, req.utterance)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def run() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.port, log_level=settings.log_level.lower())


if __name__ == "__main__":
    run()
