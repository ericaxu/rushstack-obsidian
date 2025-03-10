import { ITerminal, Executable } from '@rushstack/node-core-library';
import {
  ICloudBuildCacheProvider,
  ICredentialCacheEntry,
  CredentialCache,
  RushSession,
  EnvironmentConfiguration
} from '@rushstack/rush-sdk';
import fetch, { BodyInit, Response } from 'node-fetch';

enum CredentialsOptions {
  Optional,
  Required,
  Omit
}

enum FailureType {
  None,
  Informational,
  Warning,
  Error,
  Authentication
}

export interface IHttpBuildCacheTokenHandler {
  exec: string;
  args?: string[];
}

/**
 * @public
 */
export interface IHttpBuildCacheProviderOptions {
  url: string;
  tokenHandler?: IHttpBuildCacheTokenHandler;
  uploadMethod?: string;
  headers?: Record<string, string>;
  cacheKeyPrefix?: string;
  isCacheWriteAllowed: boolean;
  pluginName: string;
  rushProjectRoot: string;
}

export class HttpBuildCacheProvider implements ICloudBuildCacheProvider {
  private readonly _pluginName: string;
  private readonly _rushSession: RushSession;
  private readonly _rushProjectRoot: string;
  private readonly _environmentCredential: string | undefined;
  private readonly _isCacheWriteAllowedByConfiguration: boolean;
  private readonly _url: URL;
  private readonly _uploadMethod: string;
  private readonly _headers: Record<string, string>;
  private readonly _cacheKeyPrefix: string;
  private readonly _tokenHandler: IHttpBuildCacheTokenHandler | undefined;
  private __credentialCacheId: string | undefined;

  public get isCacheWriteAllowed(): boolean {
    return EnvironmentConfiguration.buildCacheWriteAllowed ?? this._isCacheWriteAllowedByConfiguration;
  }

  public constructor(options: IHttpBuildCacheProviderOptions, rushSession: RushSession) {
    this._pluginName = options.pluginName;
    this._rushSession = rushSession;
    this._rushProjectRoot = options.rushProjectRoot;

    this._environmentCredential = EnvironmentConfiguration.buildCacheCredential;
    this._isCacheWriteAllowedByConfiguration = options.isCacheWriteAllowed;
    this._url = new URL(options.url.endsWith('/') ? options.url : options.url + '/');
    this._uploadMethod = options.uploadMethod ?? 'PUT';
    this._headers = options.headers ?? {};
    this._tokenHandler = options.tokenHandler;
    this._cacheKeyPrefix = options.cacheKeyPrefix ?? '';
  }

  public async tryGetCacheEntryBufferByIdAsync(
    terminal: ITerminal,
    cacheId: string
  ): Promise<Buffer | undefined> {
    try {
      const result = await this._http({
        terminal: terminal,
        relUrl: `${this._cacheKeyPrefix}${cacheId}`,
        method: 'GET',
        body: undefined,
        warningText: 'Could not get cache entry',
        readBody: true
      });

      return Buffer.isBuffer(result) ? result : undefined;
    } catch (e) {
      terminal.writeWarningLine(`Error getting cache entry: ${e}`);
      return undefined;
    }
  }

  public async trySetCacheEntryBufferAsync(
    terminal: ITerminal,
    cacheId: string,
    objectBuffer: Buffer
  ): Promise<boolean> {
    if (!this.isCacheWriteAllowed) {
      terminal.writeErrorLine('Writing to cache is not allowed in the current configuration.');
      return false;
    }

    terminal.writeDebugLine('Uploading object with cacheId: ', cacheId);

    try {
      const result = await this._http({
        terminal: terminal,
        relUrl: `${this._cacheKeyPrefix}${cacheId}`,
        method: this._uploadMethod,
        body: objectBuffer,
        warningText: 'Could not write cache entry',
        readBody: false
      });

      return result !== false;
    } catch (e) {
      terminal.writeWarningLine(`Error uploading cache entry: ${e}`);
      return false;
    }
  }

  public async updateCachedCredentialAsync(terminal: ITerminal, credential: string): Promise<void> {
    await CredentialCache.usingAsync(
      {
        supportEditing: true
      },
      async (credentialsCache: CredentialCache) => {
        credentialsCache.setCacheEntry(this._credentialCacheId, {
          credential: credential
        });
        await credentialsCache.saveIfModifiedAsync();
      }
    );
  }

  public async updateCachedCredentialInteractiveAsync(terminal: ITerminal): Promise<void> {
    if (!this._tokenHandler) {
      throw new Error(
        `The interactive cloud credentials flow is not configured.\n` +
          `Set the 'tokenHandler' setting in 'common/config/rush-plugins/${this._pluginName}.json' to a command that writes your credentials to standard output and exits with code 0 ` +
          `or provide your credentials to rush using the --credential flag instead. Credentials must be the ` +
          `'Authorization' header expected by ${this._url.href}`
      );
    }

    const cmd: string = `${this._tokenHandler.exec} ${(this._tokenHandler.args || []).join(' ')}`;
    terminal.writeVerboseLine(`Running '${cmd}' to get credentials`);
    const result = Executable.spawnSync(this._tokenHandler.exec, this._tokenHandler.args || []);

    terminal.writeErrorLine(result.stderr);

    if (result.error) {
      throw new Error(`Could not obtain credentials. The command '${cmd}' failed.`);
    }

    const credential = result.stdout.trim();
    terminal.writeVerboseLine('Got credentials');

    await this.updateCachedCredentialAsync(terminal, credential);

    terminal.writeLine('Updated credentials cache');
  }

  public async deleteCachedCredentialsAsync(terminal: ITerminal): Promise<void> {
    await CredentialCache.usingAsync(
      {
        supportEditing: true
      },
      async (credentialsCache: CredentialCache) => {
        credentialsCache.deleteCacheEntry(this._credentialCacheId);
        await credentialsCache.saveIfModifiedAsync();
      }
    );
  }

  private get _credentialCacheId(): string {
    if (!this.__credentialCacheId) {
      const cacheIdParts: string[] = [this._url.href];

      if (this._isCacheWriteAllowedByConfiguration) {
        cacheIdParts.push('cacheWriteAllowed');
      }

      this.__credentialCacheId = cacheIdParts.join('|');
    }

    return this.__credentialCacheId;
  }

  private async _http(options: {
    terminal: ITerminal;
    relUrl: string;
    method: string;
    body: BodyInit | undefined;
    warningText: string;
    readBody: boolean;
    credentialOptions?: CredentialsOptions;
  }): Promise<Buffer | boolean> {
    const { terminal, relUrl, method, body, warningText, readBody, credentialOptions } = options;
    const safeCredentialOptions = credentialOptions ?? CredentialsOptions.Optional;
    const credentials = await this._tryGetCredentials(safeCredentialOptions);
    const url = new URL(relUrl, this._url).href;

    const headers: Record<string, string> = {};
    if (typeof credentials === 'string') {
      headers.Authorization = credentials;
    }

    for (const [key, value] of Object.entries(this._headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }

    const bodyLength = (body as { length: number })?.length || 'unknown';

    terminal.writeDebugLine(`[http-build-cache] request: ${method} ${url} ${bodyLength} bytes`);

    const response = await fetch(url, {
      method: method,
      headers: headers,
      body: body,
      redirect: 'follow'
    });

    if (!response.ok) {
      if (typeof credentials !== 'string' && safeCredentialOptions === CredentialsOptions.Optional) {
        // We tried fetching the resource without credentials and that did not work out
        // Try again but require credentials this time
        // This will trigger the provider to request credentials
        return await this._http({ ...options, credentialOptions: CredentialsOptions.Required });
      }

      this._reportFailure(terminal, method, response, false, warningText);
      return false;
    }

    const result: Buffer | boolean = readBody ? Buffer.from(await response.arrayBuffer()) : true;

    terminal.writeDebugLine(
      `[http-build-cache] actual response: ${response.status} ${url} ${
        result === true ? 'true' : result.length
      } bytes`
    );

    return result;
  }

  private async _tryGetCredentials(options: CredentialsOptions.Required): Promise<string>;
  private async _tryGetCredentials(options: CredentialsOptions.Optional): Promise<string | undefined>;
  private async _tryGetCredentials(options: CredentialsOptions.Omit): Promise<undefined>;
  private async _tryGetCredentials(options: CredentialsOptions): Promise<string | undefined>;
  private async _tryGetCredentials(options: CredentialsOptions): Promise<string | undefined> {
    if (options === CredentialsOptions.Omit) {
      return;
    }

    let credentials: string | undefined = this._environmentCredential;

    if (credentials === undefined) {
      credentials = await this._tryGetCredentialsFromCache();
    }

    if (typeof credentials !== 'string' && options === CredentialsOptions.Required) {
      throw new Error(
        [
          `Credentials for ${this._url.href} have not been provided.`,
          `In CI, verify that RUSH_BUILD_CACHE_CREDENTIAL contains a valid Authorization header value.`,
          ``,
          `For local developers, run:`,
          ``,
          `    rush update-cloud-credentials --interactive`,
          ``
        ].join('\n')
      );
    }

    return credentials;
  }

  private async _tryGetCredentialsFromCache(): Promise<string | undefined> {
    let cacheEntry: ICredentialCacheEntry | undefined;

    await CredentialCache.usingAsync(
      {
        supportEditing: false
      },
      (credentialsCache: CredentialCache) => {
        cacheEntry = credentialsCache.tryGetCacheEntry(this._credentialCacheId);
      }
    );

    if (cacheEntry) {
      const expirationTime: number | undefined = cacheEntry.expires?.getTime();
      if (!expirationTime || expirationTime >= Date.now()) {
        return cacheEntry.credential;
      }
    }
  }

  private _getFailureType(requestMethod: string, response: Response, isRedirect: boolean): FailureType {
    if (response.ok) {
      return FailureType.None;
    }

    switch (response.status) {
      case 503: {
        // We select 503 specifically because this represents "service unavailable" and
        // "rate limit throttle" errors, which are transient issues.
        //
        // There are other 5xx errors, such as 501, that can occur if the request is
        // malformed, so as a general rule we want to let through other 5xx errors
        // so the user can troubleshoot.

        // Don't fail production builds with warnings for transient issues
        return FailureType.Informational;
      }

      case 401:
      case 403:
      case 407: {
        if (requestMethod === 'GET' && (isRedirect || response.redirected)) {
          // Cache misses for GET requests are not errors
          // This is a workaround behavior where a server can issue a redirect and we fail to authenticate at the new location.
          // We do not want to signal this as an authentication failure because the authorization header is not passed on to redirects.
          // i.e The authentication header was accepted for the first request and therefore subsequent failures
          // where it was not present should not be attributed to the header.
          // This scenario usually comes up with services that redirect to pre-signed URLS that don't actually exist.
          // Those services then usually treat the 404 as a 403 to prevent leaking information.
          return FailureType.None;
        }

        return FailureType.Authentication;
      }

      case 404: {
        if (requestMethod === 'GET') {
          // Cache misses for GET requests are not errors
          return FailureType.None;
        }
      }
    }

    // Let dev builds succeed, let Prod builds fail
    return FailureType.Warning;
  }

  private _reportFailure(
    terminal: ITerminal,
    requestMethod: string,
    response: Response,
    isRedirect: boolean,
    message: string
  ): void {
    switch (this._getFailureType(requestMethod, response, isRedirect)) {
      default: {
        terminal.writeErrorLine(`${message}: HTTP ${response.status}: ${response.statusText}`);
        break;
      }

      case FailureType.Warning: {
        terminal.writeWarningLine(`${message}: HTTP ${response.status}: ${response.statusText}`);
        break;
      }

      case FailureType.Informational: {
        terminal.writeLine(`${message}: HTTP ${response.status}: ${response.statusText}`);
        break;
      }

      case FailureType.None: {
        terminal.writeDebugLine(`${message}: HTTP ${response.status}: ${response.statusText}`);
        break;
      }

      case FailureType.Authentication: {
        throw new Error(
          [
            `${this._url.href} responded with ${response.status}: ${response.statusText}.`,
            `Credentials may be misconfigured or have expired.`,
            `In CI, verify that RUSH_BUILD_CACHE_CREDENTIAL contains a valid Authorization header value.`,
            ``,
            `For local developers, run:`,
            ``,
            `    rush update-cloud-credentials --interactive`,
            ``
          ].join('\n')
        );
      }
    }
  }
}
