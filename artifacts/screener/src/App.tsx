import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { ClerkProvider, SignIn, SignUp } from '@clerk/react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Root from '@/pages/root';
import Dashboard from '@/pages/dashboard';
import AccessRestricted from '@/pages/access-restricted';
import { useTheme } from '@/hooks/use-theme';

import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import { getGetAuthStatusQueryKey, ApiError } from '@workspace/api-client-react';

/**
 * Redirect to the Clerk sign-in page when any API call returns HTTP 401.
 *
 * A 401 mid-session means the Clerk JWT has expired and the automatic
 * refresh failed (e.g. the user was offline or the refresh token itself
 * lapsed).  Rather than silently failing or showing an empty screen, we
 * send the user to sign-in so they can re-authenticate.
 *
 * This runs outside the React component tree, so we use window.location
 * instead of a hook.  The base path is read at call time from the env var
 * so it works in both root-mounted and sub-path-mounted deployments.
 */
function redirectToSignIn(): void {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  window.location.replace(`${base}/sign-in`);
}

/**
 * Global React Query error handler.
 * When any query returns a 401, the Clerk session is gone or the server has
 * rejected it.  We do two things:
 *   1. Immediately redirect to /sign-in so the user gets a clear prompt.
 *   2. Invalidate /auth/status so useRequireAuth reflects the change if the
 *      redirect is somehow delayed or blocked (e.g. an ErrorBoundary catches
 *      the navigation).
 */
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(error) {
      if (error instanceof ApiError && error.status === 401) {
        // Invalidate auth status so useRequireAuth can redirect via the hook
        queryClient.invalidateQueries({ queryKey: getGetAuthStatusQueryKey() });
        // Also do a hard redirect — more reliable than waiting for the next
        // polling cycle when the token is definitively expired.
        redirectToSignIn();
      }
    },
  }),
  defaultOptions: {
    queries: {
      /**
       * Never retry a 401 — the token is expired; retrying will just
       * produce the same response.  Redirecting to sign-in immediately
       * gives the user a clear prompt.
       */
      retry(failureCount, error) {
        if (error instanceof ApiError && error.status === 401) return false;
        return failureCount < 3;
      },
    },
  },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// External Clerk — use the key directly from the environment variable.
const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;

// Empty in dev (Clerk hits FAPI directly); auto-set in prod via the proxy.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
      </div>
      <div className="z-10 flex flex-col items-center gap-3">
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest text-center max-w-xs">
          Please use your Circle email to verify your authorization
        </p>
        <SignIn
          routing="path"
          path={`${basePath}/sign-in`}
          signUpUrl={`${basePath}/sign-up`}
          fallbackRedirectUrl={`${basePath}/`}
        />
      </div>
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
      </div>
      <div className="z-10">
        <SignUp
          routing="path"
          path={`${basePath}/sign-up`}
          signInUrl={`${basePath}/sign-in`}
          fallbackRedirectUrl={`${basePath}/`}
        />
      </div>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Root} />
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/access-restricted" component={AccessRestricted} />
        {/* REQUIRED — /*? optional wildcard matches bare path AND Clerk's OAuth sub-paths */}
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  useTheme(); // Enforces dark mode

  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
