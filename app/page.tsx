import { AccountProvider } from "@/components/auth/AccountProvider";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";
import { ThemeProvider } from "@/components/shell/ThemeProvider";
export default function Page() {
  return (
    <ThemeProvider>
      <AccountProvider>
        <WorkspaceShell />
      </AccountProvider>
    </ThemeProvider>
  );
}
