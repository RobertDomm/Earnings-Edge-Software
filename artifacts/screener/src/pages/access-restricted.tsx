import { Button } from "@/components/ui/button";
import { useGetAuthStatus, useInitiateLogin, getInitiateLoginQueryKey } from "@workspace/api-client-react";
import { Lock, ShieldAlert } from "lucide-react";

export default function AccessRestricted() {
  const { data: auth } = useGetAuthStatus();

  // Handle mock login in dev mode
  const isDev = import.meta.env.DEV;

  const mockLoginQuery = useInitiateLogin(
    { scenario: "authorized" }, 
    { query: { queryKey: getInitiateLoginQueryKey({ scenario: "authorized" }), enabled: false } }
  );

  const handleMockLogin = async () => {
    const res = await mockLoginQuery.refetch();
    if (res.data?.loginUrl) {
      window.location.href = res.data.loginUrl;
    } else {
      // Fallback if not returning a loginUrl for mock scenario
      window.location.href = "/api/auth/login?scenario=authorized";
    }
  };

  const handleRealLogin = () => {
    if (auth?.loginUrl) {
      window.location.href = auth.loginUrl;
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
      </div>
      
      <div className="z-10 w-full max-w-md border border-border bg-card p-8 shadow-2xl relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 to-orange-500"></div>
        
        <div className="mb-8 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20 text-red-500">
            <ShieldAlert className="h-8 w-8" />
          </div>
        </div>

        <h1 className="mb-2 text-center text-2xl font-semibold tracking-tight text-foreground uppercase">
          Access Restricted
        </h1>
        
        <p className="mb-8 text-center text-sm text-muted-foreground leading-relaxed">
          This application is available only to authorized community members. Please return to your community to access this tool.
        </p>

        {auth?.authenticated && !auth?.authorized && (
          <div className="rounded border border-border bg-muted/50 p-4 text-center mb-6">
            <p className="text-xs text-muted-foreground font-mono">
              USER IDENTIFIED: {auth.user?.email || "UNKNOWN"}
            </p>
            <p className="text-xs text-red-400 font-mono mt-1">
              STATUS: MISSING REQUIRED SPACE GROUP
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {(!auth?.authenticated && auth?.loginUrl) && (
            <Button onClick={handleRealLogin} className="w-full font-mono uppercase tracking-wider" size="lg">
              <Lock className="mr-2 h-4 w-4" />
              Authenticate
            </Button>
          )}

          {isDev && (
            <Button 
              variant="outline" 
              onClick={handleMockLogin} 
              className="w-full font-mono text-xs text-muted-foreground hover:text-foreground border-dashed border-muted-foreground/30"
            >
              [DEV] Inject Authorized Session
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}