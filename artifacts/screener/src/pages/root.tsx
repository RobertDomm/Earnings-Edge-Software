import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";

export default function Root() {
  const { isSignedIn, isLoaded } = useAuth();
  const [_, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      setLocation("/dashboard");
    } else {
      setLocation("/sign-in");
    }
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
