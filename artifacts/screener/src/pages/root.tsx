import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

export default function Root() {
  const { isSignedIn, isLoaded } = useAuth();
  const [_, setLocation] = useLocation();

  useEffect(() => {
    if (isLoaded) {
      setLocation(isSignedIn ? "/dashboard" : "/sign-in");
      return;
    }
    // Clerk hasn't initialised yet. On the production domain this resolves in
    // under a second. On the Replit dev domain the live keys are rejected and
    // isLoaded stays false forever — bail out after 5 s so the sign-in page
    // is shown instead of an infinite spinner.
    const timeout = setTimeout(() => setLocation("/sign-in"), 5000);
    return () => clearTimeout(timeout);
  }, [isLoaded, isSignedIn, setLocation]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-medium tracking-widest uppercase">INITIALIZING TERMINAL...</p>
      </div>
    </div>
  );
}
