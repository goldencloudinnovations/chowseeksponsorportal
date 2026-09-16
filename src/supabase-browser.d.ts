declare module 'https://esm.sh/@supabase/supabase-js@2.95.0?bundle' {
  type AuthChangeCallback = (event: string, session: unknown) => void;

  interface BrowserAuthClient {
    onAuthStateChange(callback: AuthChangeCallback): unknown;
    [key: string]: any;
  }

  interface BrowserSupabaseClient {
    auth: BrowserAuthClient;
    functions: any;
    from: any;
    rpc: any;
    [key: string]: any;
  }

  export function createClient(...args: any[]): BrowserSupabaseClient;
}
