import { useEffect } from "react";
import { useLocation } from "wouter";
import { useHandleAuthCallback, getHandleAuthCallbackQueryKey } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";

export default function Callback() {
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const code = searchParams.get("code") || undefined;
  const state = searchParams.get("state") || undefined;

  const { data, error, isLoading } = useHandleAuthCallback(
    { code, state },
    {
      query: {
        queryKey: getHandleAuthCallbackQueryKey({ code, state }),
        enabled: !!code,
      }
    }
  );

  useEffect(() => {
    if (!isLoading) {
      if (data) {
        setLocation("/");
      } else if (error) {
        setLocation("/access-restricted");
      }
    }
  }, [data, error, isLoading, setLocation]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-mono tracking-widest uppercase">AUTHORIZING...</p>
      </div>
    </div>
  );
}
