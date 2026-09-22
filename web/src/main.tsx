import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import { lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";
import { ProjectorPage } from "./pages/ProjectorPage";
import "./styles.css";

const BadgePage = lazy(() =>
  import("./pages/BadgePage").then((module) => ({ default: module.BadgePage })),
);

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="route-loading">Loading</div>}>{children}</Suspense>;
}

const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/projector/history" replace /> },
  { path: "/projector", element: <ProjectorPage /> },
  { path: "/projector/history", element: <ProjectorPage mode="history" /> },
  { path: "/badge/:token", element: <LazyPage><BadgePage /></LazyPage> },
  { path: "*", element: <Navigate to="/projector/history" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
