/**
 * custom-sign-in.test.tsx
 *
 * Verifies the email → verification-code flow in CustomSignInPage against
 * Clerk v6's Future API, which resolves to `{ error: ClerkError | null }`
 * instead of throwing on API errors.
 *
 * Critical regression covered: a Circle member with NO Clerk account gets a
 * 422 `form_identifier_not_found` from `signIn.emailCode.sendCode`. The form
 * must (a) fall back to the sign-up path so a code is actually sent, and
 * (b) never advance to the code step when sending failed.
 *
 * Run with:
 *   pnpm --filter @workspace/screener run test
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Clerk Future API mocks ─────────────────────────────────────────────────────

const sendCode = vi.fn();
const verifyCode = vi.fn();
const signInFinalize = vi.fn();
const signUpCreate = vi.fn();
const sendEmailCode = vi.fn();
const verifyEmailCode = vi.fn();
const signUpFinalize = vi.fn();

const signInMock: any = {
  status: "needs_identifier",
  emailCode: { sendCode, verifyCode },
  finalize: signInFinalize,
};
const signUpMock: any = {
  status: "missing_requirements",
  create: signUpCreate,
  verifications: { sendEmailCode, verifyEmailCode },
  finalize: signUpFinalize,
};

vi.mock("@clerk/react", () => ({
  useSignIn: () => ({ signIn: signInMock, fetchStatus: "idle" }),
  useSignUp: () => ({ signUp: signUpMock, fetchStatus: "idle" }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/sign-in", vi.fn()],
}));

import CustomSignInPage from "../pages/custom-sign-in";

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockPreflight(authorized = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorized }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function clerkError(code: string, longMessage?: string) {
  return { code, message: code, longMessage };
}

async function submitEmail(email = "newuser@example.com") {
  render(<CustomSignInPage />);
  fireEvent.change(screen.getByPlaceholderText(/email/i), {
    target: { value: email },
  });
  fireEvent.submit(screen.getByPlaceholderText(/email/i).closest("form")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPreflight(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("CustomSignInPage — email step", () => {
  it("existing user: sends sign-in code and advances to code step", async () => {
    sendCode.mockResolvedValue({ error: null });

    await submitEmail("existing@example.com");

    await waitFor(() => {
      expect(sendCode).toHaveBeenCalledWith({ emailAddress: "existing@example.com" });
    });
    // Advanced to code step
    await screen.findByText(/we sent a 6-digit code/i);
    expect(signUpCreate).not.toHaveBeenCalled();
  });

  it("new user: form_identifier_not_found falls back to sign-up and sends a code", async () => {
    sendCode.mockResolvedValue({ error: clerkError("form_identifier_not_found") });
    signUpCreate.mockResolvedValue({ error: null });
    sendEmailCode.mockResolvedValue({ error: null });

    await submitEmail("newuser@example.com");

    await waitFor(() => {
      expect(signUpCreate).toHaveBeenCalledWith({ emailAddress: "newuser@example.com" });
      expect(sendEmailCode).toHaveBeenCalled();
    });
    // Advanced to code step
    await screen.findByText(/we sent a 6-digit code/i);
  });

  it("stays on email step and shows the error when send fails for another reason", async () => {
    sendCode.mockResolvedValue({
      error: clerkError("some_other_error", "Sign-ins are currently disabled."),
    });

    await submitEmail();

    await screen.findByText("Sign-ins are currently disabled.");
    expect(signUpCreate).not.toHaveBeenCalled();
    // Still on the email step — email input is present
    expect(screen.getByPlaceholderText(/email/i)).toBeTruthy();
  });

  it("new user: shows error and stays on email step when sign-up code send fails", async () => {
    sendCode.mockResolvedValue({ error: clerkError("form_identifier_not_found") });
    signUpCreate.mockResolvedValue({ error: null });
    sendEmailCode.mockResolvedValue({
      error: clerkError("sign_up_restricted", "Sign-ups are restricted."),
    });

    await submitEmail();

    await screen.findByText("Sign-ups are restricted.");
    expect(screen.getByPlaceholderText(/email/i)).toBeTruthy();
  });

  it("new user: shows error and stays on email step when signUp.create fails", async () => {
    sendCode.mockResolvedValue({ error: clerkError("form_identifier_not_found") });
    signUpCreate.mockResolvedValue({
      error: clerkError("sign_up_forbidden", "Sign-ups are disabled."),
    });

    await submitEmail();

    await screen.findByText("Sign-ups are disabled.");
    expect(sendEmailCode).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/email/i)).toBeTruthy();
  });

  it("never touches Clerk when Circle preflight denies the email", async () => {
    mockPreflight(false);

    await submitEmail("stranger@example.com");

    await screen.findByText(/isn't authorized/i);
    expect(sendCode).not.toHaveBeenCalled();
    expect(signUpCreate).not.toHaveBeenCalled();
  });
});

describe("CustomSignInPage — code step", () => {
  /** Drive the form to the code step as an existing user. */
  async function reachCodeStep() {
    sendCode.mockResolvedValue({ error: null });
    await submitEmail("existing@example.com");
    await screen.findByText(/we sent a 6-digit code/i);
  }

  it("shows the error and does not navigate when verifyCode fails", async () => {
    await reachCodeStep();
    verifyCode.mockResolvedValue({
      error: clerkError("form_code_incorrect", "Incorrect code."),
    });

    fireEvent.change(screen.getByPlaceholderText(/000000|code/i), {
      target: { value: "123456" },
    });
    fireEvent.submit(screen.getByPlaceholderText(/000000|code/i).closest("form")!);

    await screen.findByText("Incorrect code.");
    expect(signInFinalize).not.toHaveBeenCalled();
    // Still on the code step
    expect(screen.getByText(/we sent a 6-digit code/i)).toBeTruthy();
  });

  it("shows the error and stays idle when resend fails", async () => {
    // shouldAdvanceTime keeps testing-library's async utilities working
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await reachCodeStep();
      // Let the 30s cooldown elapse so the resend button becomes active.
      await vi.advanceTimersByTimeAsync(31_000);

      sendCode.mockResolvedValue({
        error: clerkError("too_many_requests", "Too many requests."),
      });
      fireEvent.click(screen.getByText(/^Resend code$/));

      await vi.waitFor(() => {
        expect(screen.getByText("Too many requests.")).toBeTruthy();
      });
      // Button returned to idle (no cooldown restarted, no "sent" confirmation)
      expect(screen.getByText(/^Resend code$/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
