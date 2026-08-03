export type AuthUser = {
  id: string;
  email: string;
};

export type AuthState =
  | { status: "loading"; user: null; error: null }
  | { status: "anonymous"; user: null; error: null }
  | { status: "authenticated"; user: AuthUser; error: null }
  | { status: "error"; user: null; error: string };
