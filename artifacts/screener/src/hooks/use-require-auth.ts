import { useLocation } from "wouter";
import { useEffect } from "react";
import { useGetAuthStatus } from "@workspace/api-client-react";

export function useRequireAuth() {
  const [_, setLocation] = useLocation();
  const { data: auth, error } = useGetAuthStatus();

  useEffect(() => {
    if (error && (error as any)?.status === 401) {
      setLocation("/access-restricted");
      return;
    }
    
    if (auth && !auth.authorized) {
      setLocation("/access-restricted");
    }
  }, [auth, error, setLocation]);

  return { auth };
}