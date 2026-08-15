import { useAuth, useUser } from "@clerk/react";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { useGetAuthStatus, getGetAuthStatusQueryKey } from "@workspace/api-client-react";

/**
 * Redirects unauthenticated users to /sign-in.
 * Redirects authenticated-but-not-a-member users to /access-restricted.
 * Returns the combined auth state for use in protected components.
 */
export function useRequireAuth() {
  const { isSignedIn, isLoaded } = useAuth();
  const { user } = useUser();
  const [_, setLocation] = useLocation();

  // Poll the server for Circle membership status.
  // Only runs when Clerk reports the user is signed in.
  const { data: authStatus } = useGetAuthStatus({
    query: {
      queryKey: getGetAuthStatusQueryKey(),
      enabled: isLoaded && !!isSignedIn,
      refetchInterval: 5 * 60 * 1000, // re-check membership every 5 min
    },
  });

  useEffect(() => {
    if (!isLoaded) {
      // On the Replit dev domain, Clerk rejects the live key so isLoaded never
      // becomes true.  Mirror the same 5-second fallback used by the Root page
      // so the user isn't left on a protected route with an infinite spinner.
      const timeout = setTimeout(() => setLocation("/sign-in"), 5000);
      return () => clearTimeout(timeout);
    }

    // Clerk reports session is gone — send to sign-in immediately.
    if (!isSignedIn) {
      setLocation("/sign-in");
      return;
    }

    if (!authStatus) return;

    // Server says the session token is no longer valid (e.g. revoked from
    // Clerk dashboard before the SDK's own refresh cycle catches it).
    // Send to sign-in so the user gets a fresh Clerk prompt, not an opaque
    // "access restricted" page.
    if (!authStatus.authenticated) {
      setLocation("/sign-in");
      return;
    }

    // Session is valid but this email isn't a Circle Space Group member.
    if (!authStatus.authorized) {
      setLocation("/access-restricted");
    }
    return;
  }, [isLoaded, isSignedIn, authStatus, setLocation]);

  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    authStatus?.user?.email ??
    "";

  return {
    auth:
      isSignedIn && authStatus?.authorized
        ? { authorized: true as const, user: { email } }
        : null,
  };
}
