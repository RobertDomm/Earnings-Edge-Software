import { Button } from "@/components/ui/button";
import { useAuth, useUser } from "@clerk/react";
import { Lock, ShieldAlert, LogOut } from "lucide-react";
import { useClerk } from "@clerk/react";
import { useLocation } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function AccessRestricted() {
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [_, setLocation] = useLocation();

  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress;

  const handleSignIn = () => setLocation("/sign-in");

  const handleSignOut = async () => {
    await signOut();
    setLocation("/sign-in");
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
          This application is available only to authorized community members.
        </p>

        {isSignedIn && email && (
          <div className="rounded border border-border bg-muted/50 p-4 text-center mb-6">
            <p className="text-xs text-muted-foreground font-mono">
              SIGNED IN AS: {email}
            </p>
            <p className="text-xs text-red-600 dark:text-red-400 font-mono mt-1">
              STATUS: NOT A REQUIRED SPACE GROUP MEMBER
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {!isSignedIn && (
            <Button
              onClick={handleSignIn}
              className="w-full font-mono uppercase tracking-wider"
              size="lg"
            >
              <Lock className="mr-2 h-4 w-4" />
              Sign In
            </Button>
          )}

          {isSignedIn && (
            <Button
              variant="outline"
              onClick={handleSignOut}
              className="w-full font-mono uppercase tracking-wider"
              size="lg"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
