import { Cookie, CookieJar, MemoryCookieStore } from 'tough-cookie';
import { updateCookieJar } from './requests';
import { Headers } from 'headers-polyfill';
import fetch from 'cross-fetch';
import { FetchTransformOptions } from './api';
import {
  RateLimitEvent,
  RateLimitStrategy,
  WaitingRateLimitStrategy,
} from './rate-limit';
import { AuthenticationError } from './errors';
import debug from 'debug';

const log = debug('twitter-scraper:auth');

export interface TwitterAuthOptions {
  fetch: typeof fetch;
  transform: Partial<FetchTransformOptions>;
  rateLimitStrategy: RateLimitStrategy;
}

export interface TwitterAuth {
  fetch: typeof fetch;

  /**
   * How to behave when being rate-limited.
   * @param event The event information.
   */
  onRateLimit(event: RateLimitEvent): Promise<void>;

  /**
   * Returns the current cookie jar.
   */
  cookieJar(): CookieJar;

  /**
   * Returns if a user is logged-in to Twitter through this instance.
   * @returns `true` if a user is logged-in; otherwise `false`.
   */
  isLoggedIn(): Promise<boolean>;

  /**
   * Logs into a Twitter account.
   * @param username The username to log in with.
   * @param password The password to log in with.
   * @param email The email to log in with, if you have email confirmation enabled.
   * @param twoFactorSecret The secret to generate two factor authentication tokens with, if you have two factor authentication enabled.
   */
  login(
    username: string,
    password: string,
    email?: string,
    twoFactorSecret?: string,
  ): Promise<void>;

  /**
   * Logs out of the current session.
   */
  logout(): Promise<void>;

  /**
   * Deletes the current guest token token.
   */
  deleteToken(): void;

  /**
   * Returns if the authentication state has a token.
   * @returns `true` if the authentication state has a token; `false` otherwise.
   */
  hasToken(): boolean;

  /**
   * Returns the time that authentication was performed.
   * @returns The time at which the authentication token was created, or `null` if it hasn't been created yet.
   */
  authenticatedAt(): Date | null;

  /**
   * Installs the authentication information into a headers-like object. If needed, the
   * authentication token will be updated from the API automatically.
   * @param headers A Headers instance representing a request's headers.
   */
  installTo(headers: Headers, url: string): Promise<void>;
}

/**
 * Wraps the provided fetch function with transforms.
 * @param fetchFn The fetch function.
 * @param transform The transform options.
 * @returns The input fetch function, wrapped with the provided transforms.
 */
function withTransform(
  fetchFn: typeof fetch,
  transform?: Partial<FetchTransformOptions>,
): typeof fetch {
  return async (input, init) => {
    const fetchArgs = (await transform?.request?.(input, init)) ?? [
      input,
      init,
    ];
    const res = await fetchFn(...fetchArgs);
    return (await transform?.response?.(res)) ?? res;
  };
}

/**
 * A guest authentication token manager. Automatically handles token refreshes.
 */
export class TwitterGuestAuth implements TwitterAuth {
  protected bearerToken: string;
  protected jar: CookieJar;
  protected guestToken?: string;
  protected guestCreatedAt?: Date;
  protected rateLimitStrategy: RateLimitStrategy;

  fetch: typeof fetch;

  constructor(
    bearerToken: string,
    protected readonly options?: Partial<TwitterAuthOptions>,
  ) {
    this.fetch = withTransform(options?.fetch ?? fetch, options?.transform);
    this.rateLimitStrategy =
      options?.rateLimitStrategy ?? new WaitingRateLimitStrategy();
    this.bearerToken = bearerToken;
    this.jar = new CookieJar();
  }

  async onRateLimit(event: RateLimitEvent): Promise<void> {
    await this.rateLimitStrategy.onRateLimit(event);
  }

  cookieJar(): CookieJar {
    return this.jar;
  }

  isLoggedIn(): Promise<boolean> {
    return Promise.resolve(false);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  login(_username: string, _password: string, _email?: string): Promise<void> {
    return this.updateGuestToken();
  }

  logout(): Promise<void> {
    this.deleteToken();
    this.jar = new CookieJar();
    return Promise.resolve();
  }

  deleteToken() {
    delete this.guestToken;
    delete this.guestCreatedAt;
  }

  hasToken(): boolean {
    return this.guestToken != null;
  }

  authenticatedAt(): Date | null {
    if (this.guestCreatedAt == null) {
      return null;
    }

    return new Date(this.guestCreatedAt);
  }

  async installTo(headers: Headers): Promise<void> {
    if (this.shouldUpdate()) {
      await this.updateGuestToken();
    }

    const token = this.guestToken;
    if (token == null) {
      throw new AuthenticationError(
        'Authentication token is null or undefined.',
      );
    }

    headers.set('authorization', `Bearer ${this.bearerToken}`);
    headers.set('x-guest-token', token);

    const cookies = await this.getCookies();
    const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');
    if (xCsrfToken) {
      headers.set('x-csrf-token', xCsrfToken.value);
    }

    headers.set('cookie', await this.getCookieString());
  }

  protected async getCookies(): Promise<Cookie[]> {
    return this.jar.getCookies(this.getCookieJarUrl());
  }

  protected async getCookieString(): Promise<string> {
    const cookies = await this.getCookies();
    return cookies.map((cookie) => `${cookie.key}=${cookie.value}`).join('; ');
  }

  protected async removeCookie(key: string): Promise<void> {
    //@ts-expect-error don't care
    const store: MemoryCookieStore = this.jar.store;
    const cookies = await this.jar.getCookies(this.getCookieJarUrl());
    for (const cookie of cookies) {
      if (!cookie.domain || !cookie.path) continue;
      store.removeCookie(cookie.domain, cookie.path, key);

      if (typeof document !== 'undefined') {
        document.cookie = `${cookie.key}=; Max-Age=0; path=${cookie.path}; domain=${cookie.domain}`;
      }
    }
  }

  private getCookieJarUrl(): string {
    return typeof document !== 'undefined'
      ? document.location.toString()
      : 'https://x.com';
  }

  /**
   * Updates the authentication state with a new guest token from the Twitter API.
   */
  protected async updateGuestToken() {
    const guestActivateUrl = 'https://api.x.com/1.1/guest/activate.json';

    const headers = new Headers({
      Authorization: `Bearer ${this.bearerToken}`,
      Cookie: await this.getCookieString(),
    });

    log(`Making POST request to ${guestActivateUrl}`);

    const res = await this.fetch(guestActivateUrl, {
      method: 'POST',
      headers: headers,
      referrerPolicy: 'no-referrer',
    });

    await updateCookieJar(this.jar, res.headers);

    if (!res.ok) {
      throw new AuthenticationError(await res.text());
    }

    const o = await res.json();
    if (o == null || o['guest_token'] == null) {
      throw new AuthenticationError('guest_token not found.');
    }

    const newGuestToken = o['guest_token'];
    if (typeof newGuestToken !== 'string') {
      throw new AuthenticationError('guest_token was not a string.');
    }

    this.guestToken = newGuestToken;
    this.guestCreatedAt = new Date();
  }

  /**
   * Returns if the authentication token needs to be updated or not.
   * @returns `true` if the token needs to be updated; `false` otherwise.
   */
  private shouldUpdate(): boolean {
    return (
      !this.hasToken() ||
      (this.guestCreatedAt != null &&
        this.guestCreatedAt <
          new Date(new Date().valueOf() - 3 * 60 * 60 * 1000))
    );
  }
}
