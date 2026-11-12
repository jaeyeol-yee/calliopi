/** Untyped optional peer. Only `auth` is used, and only by the interactive login path. */
declare module "@cursor/sdk" {
  export interface CursorLoginResult {
    apiKey: string;
    email?: string;
    apiKeyExpiresAtMs: number;
  }
  export interface CursorAuthStatus {
    status?: string;
    email?: string;
  }
  export const Cursor: {
    auth: {
      status(): Promise<CursorAuthStatus>;
      logout(): Promise<void>;
      login(opts: { apiKeyName?: string; onLoginUrl?: (url: string) => void }): Promise<CursorLoginResult>;
    };
  };
}
