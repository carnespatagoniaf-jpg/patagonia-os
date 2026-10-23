import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import * as Sentry from "@sentry/react";

/**
 * Pantallas que se bajan recién cuando se abren (la web arranca con menos
 * para descargar). Mostrador e Inicio NO van por acá: se usan todo el día y
 * Mostrador tiene que poder abrirse sin internet.
 */
const loaders: (() => Promise<unknown>)[] = [];

export function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  loaders.push(load);
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

/** Con la web ya abierta, se bajan de fondo las demás pantallas: después se
 * abren al toque y también andan si se corta internet. */
export function prefetchPages() {
  const run = () => loaders.forEach((load) => void load().catch(() => undefined));
  setTimeout(() => {
    // Con tope: si la pantalla nunca queda "ociosa" (una animación, por ejemplo), igual se bajan.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
    if (idle) idle(run, { timeout: 3000 });
    else run();
  }, 4000);
}

/** Si una pantalla no se pudo bajar (sin internet, o la web se actualizó y el
 * archivo viejo ya no está), se avisa ahí mismo sin tirar el resto del sistema. */
class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Igual que antes con el ErrorBoundary general: todo error queda en Sentry.
    Sentry.captureException(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="message warning">
        No se pudo abrir esta pantalla. Si se cortó internet, esperá a que vuelva y{" "}
        <button className="secondary" onClick={() => window.location.reload()}>recargá la página</button>.
        {" "}Mostrador sigue andando desde el menú.
      </div>
    );
  }
}

export function PageFrame({ children }: { children: ReactNode }) {
  return (
    <PageBoundary>
      <Suspense fallback={<p className="muted">Cargando…</p>}>{children}</Suspense>
    </PageBoundary>
  );
}
