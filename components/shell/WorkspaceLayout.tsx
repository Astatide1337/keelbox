import type { ReactNode } from "react";
export function WorkspaceLayout({
  header,
  navigation,
  children,
}: {
  header: ReactNode;
  navigation: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <a href="#workspace-main" className="skip-link">
        Skip to workspace
      </a>
      {header}
      <div className="shell-body">
        {navigation}
        <main id="workspace-main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
