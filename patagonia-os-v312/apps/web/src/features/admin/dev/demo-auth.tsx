/** Reemplazo de AuthProvider para la vista de prueba del panel (sin login real). */
export function useAuth() {
  return {
    signOut: async () => {
      window.alert("Vista de prueba: acá saldrías del panel.");
    }
  };
}
