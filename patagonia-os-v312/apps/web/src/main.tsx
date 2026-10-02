import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import { AuthProvider } from "./features/auth/AuthProvider";
import "./styles.css";
import { installSerialTabResponder } from "./features/inventory/kretz/serial-tabs";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) {
  Sentry.init({ dsn: sentryDsn, environment: import.meta.env.MODE });
}

function ErrorFallback() {
  return (
    <div className="login-card" style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
      <p className="eyebrow">PATAGONIA OS</p>
      <h1>Ocurrió un error</h1>
      <p className="muted">Ya quedó registrado. Probá recargar la página.</p>
      <button style={{ marginTop: 16 }} onClick={() => window.location.reload()}>Recargar</button>
    </div>
  );
}

// Cada pestaña avisa si tiene la balanza tomada y la suelta si "Probar todo" lo pide.
installSerialTabResponder();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
