'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_EDGE = 640;
const JPEG_QUALITY = 0.82;

/**
 * Captures a patient photo from the device camera or a file, downscaling on the
 * client so a 12 MP phone image does not become a multi-megabyte payload.
 */
export function PhotoCapture({
  value,
  onChange,
  label,
}: {
  value: string | null | undefined;
  onChange: (dataUrl: string | null) => void;
  label: string;
}) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsCapturing(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const downscale = (source: CanvasImageSource, width: number, height: number): string => {
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  };

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Front camera: registration photos are taken facing the patient at a desk.
        video: { facingMode: 'user', width: { ideal: 1280 } },
      });
      streamRef.current = stream;
      setIsCapturing(true);
      queueMicrotask(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      });
    } catch {
      setError('Camera unavailable — upload a file instead');
    }
  };

  const snap = () => {
    const video = videoRef.current;
    if (!video) return;
    onChange(downscale(video, video.videoWidth, video.videoHeight));
    stopCamera();
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => onChange(downscale(img, img.width, img.height));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <span className="label">{label}</span>

      {value && !isCapturing && (
        <div className="flex items-center gap-3">

          <img
            src={value}
            alt="Patient"
            className="size-28 rounded-lg border border-slate-300 object-cover"
          />
          <button type="button" className="btn-secondary" onClick={() => onChange(null)}>
            Remove
          </button>
        </div>
      )}

      {isCapturing && (
        <div className="space-y-2">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full max-w-xs rounded-lg border border-slate-300"
          />
          <div className="flex gap-2">
            <button type="button" className="btn-primary" onClick={snap}>
              Capture
            </button>
            <button type="button" className="btn-secondary" onClick={stopCamera}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!value && !isCapturing && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={() => void startCamera()}>
            Use camera
          </button>
          <label className="btn-secondary cursor-pointer">
            Upload
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
          </label>
        </div>
      )}

      {error && <p className="mt-1 text-xs text-amber-700">{error}</p>}
    </div>
  );
}
