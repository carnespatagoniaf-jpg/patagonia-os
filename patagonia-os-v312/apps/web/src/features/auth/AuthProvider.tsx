import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";

export interface UserProfile {
  id: string;
  company_id: string;
  branch_id: string | null;
  full_name: string;
  role: "owner" | "admin" | "manager" | "cashier" | "production" | "readonly";
  active: boolean;
}

interface AuthContextValue {
  loading: boolean;
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  passwordRecovery: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(newPassword: string): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  async function loadProfile(userId: string) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("id,company_id,branch_id,full_name,role,active")
      .eq("id", userId)
      .single();

    if (error) throw error;
    if (!data.active) throw new Error("El usuario está desactivado.");
    setProfile(data as UserProfile);
  }

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session?.user) await loadProfile(data.session.user.id);
      setLoading(false);
    }).catch(() => setLoading(false));

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, nextSession) => {
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
      setSession(nextSession);
      setProfile(null);
      if (nextSession?.user) {
        try {
          await loadProfile(nextSession.user.id);
        } catch {
          if (supabase) await supabase.auth.signOut();
        }
      }
      setLoading(false);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    if (!supabase) throw new Error("Supabase todavía no está configurado.");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.user) throw new Error("No se pudo iniciar sesión.");
    await loadProfile(data.user.id);
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setPasswordRecovery(false);
  }

  async function sendPasswordReset(email: string) {
    if (!supabase) throw new Error("Supabase todavía no está configurado.");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) throw error;
  }

  async function updatePassword(newPassword: string) {
    if (!supabase) throw new Error("Supabase todavía no está configurado.");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    setPasswordRecovery(false);
  }

  const value = useMemo<AuthContextValue>(() => ({
    loading,
    session,
    user: session?.user ?? null,
    profile,
    passwordRecovery,
    signIn,
    signOut,
    sendPasswordReset,
    updatePassword
  }), [loading, session, profile, passwordRecovery]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return value;
}
