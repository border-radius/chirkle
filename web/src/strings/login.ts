// The login, signup and password reset pages' text (views/login.ts; DESIGN.md §22, §39). One module per screen
// (docs/REFACTOR.md item 56), loaded with that screen's chunk: a screen's copy changes here, and a translation would
// replace these.

export const EMAIL = "Email";
export const PASSWORD = "Password";
export const NEW_PASSWORD = "New password";
export const DISPLAY_NAME = "Display name";
export const INVITE_CODE = "Invite code";

export const LOG_IN = "Log in";
export const SIGN_UP = "Sign up";
export const RESET_PASSWORD = "Reset password";
export const SET_NEW_PASSWORD = "Set a new password";
export const SEND_LINK = "Send link";
export const SET_PASSWORD = "Set password";
export const FORGOT_PASSWORD = "Forgot password?";
export const BACK_TO_LOG_IN = "Back to log in";
export const JUST_LOOKING = "Just looking? Read the Open Air rooms";

export const FORGOT_HINT = "Enter your account's email, and we'll send you a link to set a new password.";
export const resetHint = (min: number) => `At least ${min} characters. Every device logged in to this account is logged out.`;
export const linkSent = (email: string) =>
  `If an account uses ${email}, a link to set a new password is on its way. It works for 30 minutes.`;

export const nameTooLong = (max: number) => `Must be no more than ${max} characters.`;
export const PASSWORD_TOO_LONG = "Use at most 71 characters (fewer if some aren't plain Latin letters, digits or punctuation).";
export const PASSWORD_CHANGED = "Your password was changed. Log in with it.";
export const createdButNotLoggedIn = (why: string) => `Your account was created, but logging in failed: ${why} Log in to continue.`;
export const EMAIL_TAKEN = "There is already an account with this email. Log in instead.";
export const LINK_EXPIRED = "This link has expired or was already used. Ask for a new one.";
export const WRONG_LOGIN = "Wrong email or password.";
