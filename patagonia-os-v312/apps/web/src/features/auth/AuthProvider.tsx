import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { clearStoredPosReceipt } from "../../lib/pos-receipt-storage";

export interface UserProfile {
  id: string;
  company_id: string;
  branch_id: string | null;
  full_name: string;
  role: "owner" | "admin" | "manager" | "cashier" | "production" | "readonly";
  active: boolean;
  denied_permissions?: string[];
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

const DEMO_PROFILE: UserProfile = {
  id: "demo-user",
  company_id: "demo-company",
  branch_id: "demo-branch",
  full_name: "Demo",
  role: "owner",
  active: true
};

/** El perfil se cargó bien y dice que este usuario NO puede entrar
 * (desactivado, empresa desactivada, sin perfil y sin ser admin de
 * plataforma) -- único caso donde corresponde cerrar la sesión. Cualquier
 * otro error (401 por una carrera con el token, un corte de red) es
 * transitorio y NO tiene que sacar al usuario del sistema. */
class DefinitiveProfileError extends Error {}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(isSupabaseConfigured ? null : DEMO_PROFILE);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  // signIn() ya llama a loadProfile() directamente; sin esto, el evento
  // SIGNED_IN de onAuthStateChange dispara una segunda llamada en paralelo
  // a la misma consulta, y una de las dos puede volver vacía (visto en
  // producción: mismo usuario, mismo filtro, una respuesta con la fila y
  // la otra sin ninguna). Esta bandera evita la carrera.
  const signingInRef = useRef(false);
  // Para poder saber, dentro del listener de onAuthStateChange (que se
  // registra una sola vez, con closure fijo), si el perfil YA cargado
  // corresponde al usuario de la sesión actual -- leer el estado `profile`
  // ahí adentro daría siempre su valor viejo del montaje inicial.
  const loadedProfileUserIdRef = useRef<string | null>(null);

  async function loadProfile(userId: string) {
    if (!supabase) return;
    // Si el usuario cambió (login con otra cuenta en la misma pestaña, sin
    // pasar por signOut()), limpiar datos de sesión que no están scopeados
    // por empresa -- por ej. el "Último comprobante" de Mostrador, que
    // quedaba pegado de la cuenta anterior (ver pos-receipt-storage.ts).
    if (loadedProfileUserIdRef.current && loadedProfileUserIdRef.current !== userId) clearStoredPosReceipt();
    const { data, error } = await supabase
      .from("profiles")
      .select("id,company_id,branch_id,full_name,role,active,denied_permissions,companies(active)")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      // Sin fila en profiles: puede ser un platform admin (da de alta
      // clientes nuevos, no pertenece a ninguna empresa) en vez de un
      // usuario sin perfil real.
      const { data: isAdmin, error: adminError } = await supabase.rpc("am_i_platform_admin");
      // Si la consulta falló, no se sabe si es admin -- no es lo mismo que
      // "no es admin", y no tiene que terminar en cerrar la sesión.
      if (adminError) throw adminError;
      setIsPlatformAdmin(Boolean(isAdmin));
      setProfile(null);
      if (!isAdmin) {
        loadedProfileUserIdRef.current = null;
        throw new DefinitiveProfileError("No se encontró tu perfil.");
      }
      // Igual que un usuario común: marcar que ya está cargado, para que
      // un refresh de token no vuelva a pedir todo y arriesgue una falla.
      loadedProfileUserIdRef.current = userId;
      return;
    }

    if (!data.active) throw new DefinitiveProfileError("El usuario está desactivado.");
    const company = data.companies as unknown as { active: boolean } | { active: boolean }[] | null;
    const companyActive = Array.isArray(company) ? (company[0]?.active ?? true) : (company?.active ?? true);
    if (!companyActive) throw new DefinitiveProfileError("Esta empresa está desactivada.");
    setIsPlatformAdmin(false);
    setProfile(data as UserProfile);
    loadedProfileUserIdRef.current = userId;
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

    async function loadProfileWithRetry(userId: string) {
      const delays = [500, 1500];
      for (let attempt = 0; ; attempt++) {
        try {
          await loadProfile(userId);
          return;
        } catch (err) {
          if (err instanceof DefinitiveProfileError || attempt >= delays.length) throw err;
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }
    }

    async function reloadProfileAfterAuthChange(userId: string) {
      try {
        await loadProfileWithRetry(userId);
      } catch (err) {
        // Solo se cierra la sesión si el perfil dice que no puede entrar.
        // Antes CUALQUIER error sacaba al usuario -- y el pedido de perfil
        // hecho ADENTRO del callback de onAuthStateChange salía con la
        // clave anónima (sin la sesión, todavía no aplicada), daba 401 y
        // cerraba la sesión del admin de plataforma al poco de entrar
        // (visto en los registros de producción).
        if (err instanceof DefinitiveProfileError && supabase) await supabase.auth.signOut();
      }
      setLoading(false);
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true);
      setSession(nextSession);
      if (signingInRef.current) {
        // signIn() está manejando este login directamente; evitar una
        // segunda llamada a loadProfile en paralelo.
        setLoading(false);
        return;
      }
      const user = nextSession?.user;
      // TOKEN_REFRESHED es solo una renovación del token del mismo usuario,
      // y SIGNED_IN también se dispara solo al volver a la pestaña. Si ya
      // tenemos el perfil de ESE usuario cargado, no hace falta pedirlo de
      // nuevo (también vale para el admin de plataforma, que no tiene fila
      // en profiles).
      if ((event === "TOKEN_REFRESHED" || event === "SIGNED_IN") && user && loadedProfileUserIdRef.current === user.id) {
        setLoading(false);
        return;
      }
      setProfile(null);
      if (!user) {
        setLoading(false);
        return;
      }
      // Diferido: llamar a supabase adentro del callback, mientras el
      // cliente todavía tiene tomado el candado de la sesión, hace que el
      // pedido salga sin el token del usuario.
      setTimeout(() => void reloadProfileAfterAuthChange(user.id), 0);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    if (!supabase) throw new Error("Supabase todavía no está configurado.");
    signingInRef.current = true;
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.user) throw new Error("No se pudo iniciar sesión.");
      try {
        await loadProfile(data.user.id);
      } catch (err) {
        if (err instanceof DefinitiveProfileError) await supabase.auth.signOut();
        throw err;
      }
    } finally {
      signingInRef.current = false;
    }
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    loadedProfileUserIdRef.current = null;
    setPasswordRecovery(false);
    setIsPlatformAdmin(false);
    clearStoredPosReceipt();
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
