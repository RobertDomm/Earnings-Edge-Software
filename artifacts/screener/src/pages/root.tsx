import { useLocation } from "wouter";
import { useGetAuthStatus } from "@workspace/api-client-react";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

export default function Root() {
  const [_, setLocation] = useLocation();
  const { data: auth, isLoading, error } = useGetAuthStatus();

  useEffect(() => {
    if (!isLoading && auth) {
      if (auth.authorized) {
        setLocation("/dashboard");
      } else {
        setLocation("/access-restricted");
      }
    } else if (!isLoading && error) {
      setLocation("/access-restricted");
    }
  }, [auth, isLoading, error, setLocation]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-medium tracking-widest uppercase">INITIALIZING TERMINAL...</p>
      </div>
    </div>
  );
}
