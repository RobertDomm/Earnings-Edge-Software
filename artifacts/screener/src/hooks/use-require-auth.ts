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
    if (!isLoaded) return;

    if (!isSignedIn) {
      setLocation("/sign-in");
      return;
    }

    if (authStatus && !authStatus.authorized) {
      setLocation("/access-restricted");
    }
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
