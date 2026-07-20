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
  isPlatformAdmin: boolean;
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
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  async function loadProfile(userId: string) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("profiles")
      .select("id,company_id,branch_id,full_name,role,active")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      // Sin fila en profiles: puede ser un platform admin (da de alta
      // clientes nuevos, no pertenece a ninguna empresa) en vez de un
      // usuario sin perfil real.
      const { data: isAdmin } = await supabase.rpc("am_i_platform_admin");
      setIsPlatformAdmin(Boolean(isAdmin));
      setProfile(null);
      if (!isAdmin) throw new Error("No se encontró tu perfil.");
      return;
    }

    if (!data.active) throw new Error("El usuario está desactivado.");
    setIsPlatformAdmin(false);
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
    setIsPlatformAdmin(false);
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
    isPlatformAdmin,
    signIn,
    signOut,
    sendPasswordReset,
    updatePassword
  }), [loading, session, profile, passwordRecovery, isPlatformAdmin]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return value;
}
