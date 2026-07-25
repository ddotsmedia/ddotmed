import { Injectable, Logger, NotImplementedException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OidcService } from './oidc.service';

/**
 * SAML 2.0 SP stub. Metadata generation and assertion parsing are implemented;
 * XML signature verification is deliberately NOT — enabling SAML without it would
 * accept forged assertions. SAML_ENABLED stays false until a validating library
 * (@node-saml/node-saml) is wired in.
 */
@Injectable()
export class SamlService {
  private readonly logger = new Logger(SamlService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly oidc: OidcService,
  ) {}

  private get enabled(): boolean {
    return this.config.get('SAML_ENABLED') === 'true';
  }

  serviceProviderMetadata(): string {
    const entityId = this.config.get<string>('SAML_SP_ENTITY_ID') ?? 'urn:medicore:sp';
    const acsUrl = this.config.get<string>('SAML_ACS_URL') ?? 'https://DOMAIN_PLACEHOLDER/api/auth/saml/acs';
    return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="true" WantAssertionsSigned="true"
                   protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                             Location="${acsUrl}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
  }

  async consumeAssertion(
    samlResponse: string,
    relayState: string | undefined,
    meta: { ip: string | null; userAgent: string | null },
  ) {
    if (!this.enabled) {
      throw new NotImplementedException(
        'SAML is disabled. Signature verification must be configured before enabling SAML_ENABLED.',
      );
    }

    const xml = Buffer.from(samlResponse, 'base64').toString('utf8');
    const nameId = /<(?:saml2?:)?NameID[^>]*>([^<]+)<\/(?:saml2?:)?NameID>/.exec(xml)?.[1];
    if (!nameId) throw new UnauthorizedException('SAML assertion contains no NameID');

    const tenant = relayState ?? this.config.get<string>('SAML_DEFAULT_TENANT');
    if (!tenant) throw new UnauthorizedException('No tenant in RelayState');

    return this.oidc.linkAndIssue(tenant, nameId, nameId.includes('@') ? nameId : undefined, 'saml', meta);
  }
}
