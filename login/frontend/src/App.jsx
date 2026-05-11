import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import UserWorkspacePage from "./UserWorkspacePage";
import { apiJson, formatDateTime, usePageMeta } from "./app-shared";

const THEME_STORAGE_KEY = "voxscribe-ui-theme";

function isSupportedTheme(theme) {
  return theme === "light" || theme === "dark";
}

function getSystemTheme() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialTheme() {
  if (typeof window === "undefined") {
    return "light";
  }

  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isSupportedTheme(storedTheme) ? storedTheme : getSystemTheme();
}

function applyTheme(theme) {
  if (typeof document === "undefined") {
    return;
  }

  const normalizedTheme = isSupportedTheme(theme) ? theme : "light";
  document.documentElement.dataset.theme = normalizedTheme;
  document.documentElement.style.colorScheme = normalizedTheme;
}

function App() {
  const [theme, setTheme] = useState(getInitialTheme);
  const path = window.location.pathname;

  useLayoutEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isSupportedTheme(storedTheme) || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event) => {
      setTheme(event.matches ? "dark" : "light");
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  const handleThemeToggle = () => {
    setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"));
  };

  let page = <RegularLoginPage />;

  if (path === "/superadmin-login") {
    page = <SuperAdminLoginPage />;
  } else if (path === "/app") {
    page = <UserWorkspacePage />;
  } else if (path === "/admin") {
    page = <AdminPage />;
  }

  return (
    <>
      {page}
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={handleThemeToggle}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      >
        <span className="theme-toggle-btn-label">Theme</span>
        <span className="theme-toggle-btn-value">{theme === "dark" ? "Dark" : "Light"}</span>
      </button>
    </>
  );
}

function AuthScene({ children }) {
  return (
    <div className="auth-page">
      <div className="auth-shell">
        <div className="auth-brand">Voxscribe</div>

        <div className="auth-shape auth-shape-one" />
        <div className="auth-shape auth-shape-two" />
        <div className="auth-shape auth-shape-three" />
        <div className="auth-shape auth-shape-four" />
        <div className="auth-shape auth-shape-five" />

        <div className="auth-content">
          <IllustrationPanel />
          {children}
        </div>
      </div>
    </div>
  );
}

function IllustrationPanel() {
  return (
    <div className="illustration-panel">
      <div className="watermark-copy">
        Dream
        <br />
        Comes
        <br />
        True
      </div>

      <div className="plant plant-left">
        <span className="leaf leaf-a" />
        <span className="leaf leaf-b" />
        <span className="leaf leaf-c" />
        <span className="stem" />
      </div>

      <div className="office-person">
        <div className="office-hair" />
        <div className="office-head" />
        <div className="office-neck" />
        <div className="office-body" />
        <div className="office-shirt" />
        <div className="office-blazer-left" />
        <div className="office-blazer-right" />
        <div className="office-arm-left" />
        <div className="office-arm-right" />
        <div className="office-hand-left" />
        <div className="office-hand-right" />
        <div className="office-bag-strap" />
        <div className="office-bag" />
        <div className="office-laptop" />
        <div className="office-legs">
          <div className="office-leg-left">
            <div className="office-shoe-left" />
          </div>
          <div className="office-leg-right">
            <div className="office-shoe-right" />
          </div>
        </div>
      </div>

      <div className="plant plant-right">
        <span className="leaf leaf-a" />
        <span className="leaf leaf-b" />
        <span className="leaf leaf-c" />
        <span className="stem" />
      </div>

      <div className="ground-shadow" />
    </div>
  );
}

function OtpInputs({ values, onChange, onBackspace, onPaste, refs }) {
  return (
    <div className="otp-boxes">
      {values.map((value, index) => (
        <input
          key={index}
          ref={(element) => {
            refs.current[index] = element;
          }}
          className="otp-input"
          type="text"
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={value}
          onChange={(event) => onChange(index, event.target.value)}
          onKeyDown={(event) => onBackspace(index, event)}
          onPaste={onPaste}
        />
      ))}
    </div>
  );
}

function RegularLoginPage() {
  usePageMeta("Voxscribe Login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginMessage, setLoginMessage] = useState("");
  const [loginMessageType, setLoginMessageType] = useState("error");
  const [otpValues, setOtpValues] = useState(["", "", "", "", "", ""]);
  const [otpError, setOtpError] = useState("");
  const [otpSuccess, setOtpSuccess] = useState("");
  const [otpNote, setOtpNote] = useState("All 6 digits are required");
  const [showOtpStep, setShowOtpStep] = useState(false);
  const [otpChallengeId, setOtpChallengeId] = useState("");
  const [loginPending, setLoginPending] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const otpRefs = useRef([]);

  const otp = otpValues.join("");
  const canContinue = /^\d{6}$/.test(otp) && !isLoggedIn;

  const focusOtpIndex = (index) => {
    otpRefs.current[index]?.focus();
  };

  const handleOtpChange = (index, nextValue) => {
    const sanitized = String(nextValue || "").replace(/\D/g, "").slice(-1);
    const nextOtpValues = [...otpValues];
    nextOtpValues[index] = sanitized;
    setOtpValues(nextOtpValues);
    setOtpError("");

    if (sanitized && index < otpValues.length - 1) {
      focusOtpIndex(index + 1);
    }
  };

  const handleOtpKeyDown = (index, event) => {
    if (event.key === "Backspace" && !otpValues[index] && index > 0) {
      focusOtpIndex(index - 1);
    }
  };

  const handleOtpPaste = (event) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);

    if (!pasted) {
      return;
    }

    const nextOtpValues = ["", "", "", "", "", ""];
    pasted.split("").forEach((char, index) => {
      nextOtpValues[index] = char;
    });
    setOtpValues(nextOtpValues);
    setOtpError("");
    focusOtpIndex(Math.min(pasted.length, 5));
  };

  const resetOtpStep = () => {
    setOtpValues(["", "", "", "", "", ""]);
    setOtpError("");
    setOtpSuccess("");
    setOtpNote("All 6 digits are required");
    setOtpChallengeId("");
    setIsLoggedIn(false);
    setLogoutPending(false);
  };

  const handleLoginSubmit = async (event) => {
    event.preventDefault();

    if (!email.trim() || !password.trim()) {
      setLoginMessage("Please enter email and password.");
      setLoginMessageType("error");
      return;
    }

    setLoginPending(true);
    setLoginMessage("Checking your account...");
    setLoginMessageType("success");
    setOtpError("");
    setOtpSuccess("");

    try {
      const { response, data } = await apiJson("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
        }),
      });

      if (!response.ok || !data.success) {
        setLoginMessage(data.message || "Login failed.");
        setLoginMessageType("error");
        return;
      }

      setOtpChallengeId(data.challengeId || "");
      setOtpNote("Enter the OTP sent to your email address.");
      setShowOtpStep(true);
      setLoginMessage(data.message || "Email and password are correct. Enter OTP to continue.");
      setLoginMessageType("success");

      window.setTimeout(() => {
        focusOtpIndex(0);
      }, 150);
    } catch {
      setLoginMessage("Unable to reach server. Please try again.");
      setLoginMessageType("error");
    } finally {
      setLoginPending(false);
    }
  };

  const handleBack = () => {
    setShowOtpStep(false);
    resetOtpStep();
  };

  const handleVerifyOtp = async () => {
    if (!/^\d{6}$/.test(otp)) {
      setOtpError("Please enter a valid 6 digit OTP.");
      setOtpSuccess("");
      return;
    }

    if (!otpChallengeId) {
      setOtpError("Please login with email and password first.");
      setOtpSuccess("");
      setShowOtpStep(false);
      return;
    }

    setVerifyPending(true);
    setOtpError("");
    setOtpSuccess("");

    try {
      const { response, data } = await apiJson("/api/login/verify-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          challengeId: otpChallengeId,
          otp,
        }),
      });

      if (!response.ok || !data.success) {
        setOtpError(data.message || "OTP verification failed.");
        return;
      }

      setOtpChallengeId("");
      setIsLoggedIn(true);
      setOtpSuccess(data.message || "Logged successfully.");
      setOtpNote("OTP verified! Opening application...");
      setLoginMessage(data.message || "Logged successfully.");
      setLoginMessageType("success");

      window.setTimeout(() => {
        window.location.assign("/app");
      }, 450);
    } catch {
      setOtpError("Unable to verify OTP. Please try again.");
    } finally {
      setVerifyPending(false);
    }
  };

  const handleLogout = async () => {
    setLogoutPending(true);

    try {
      const { data } = await apiJson("/api/logout", {
        method: "POST",
      });

      setLoginMessage(data.message || "Logged out successfully.");
      setLoginMessageType("success");
      setEmail("");
      setPassword("");
      setShowOtpStep(false);
      resetOtpStep();
    } catch {
      setOtpError("Unable to logout. Please try again.");
    } finally {
      setLogoutPending(false);
    }
  };

  return (
    <AuthScene>
      <div className={`auth-card login-card ${showOtpStep ? "show-otp" : ""}`}>
        <div className="card-stage">
          <section className="form-step step-login">
            <h1>Login</h1>

            <form onSubmit={handleLoginSubmit} noValidate>
              <div className="field-group">
                <label htmlFor="user-email">Email</label>
                <div className="input-wrap">
                  <input
                    id="user-email"
                    type="email"
                    placeholder="enter email address"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              </div>

              <div className="field-group">
                <label htmlFor="user-password">Password</label>
                <div className="input-wrap">
                  <input
                    id="user-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    className="toggle-password"
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              <div className={`inline-message ${loginMessageType}`}>{loginMessage}</div>

              <button type="submit" className="primary-pill-btn" disabled={loginPending}>
                {loginPending ? "Checking..." : "Login"}
              </button>

              <a href="/superadmin-login" className="superadmin-link">
                Super Admin Login &gt;
              </a>
            </form>
          </section>

          <section className="form-step step-otp">
            <h1>OTP Verify</h1>
            <p className="otp-subtitle">Enter the 6 digit OTP sent to your email</p>

            <OtpInputs
              values={otpValues}
              onChange={handleOtpChange}
              onBackspace={handleOtpKeyDown}
              onPaste={handleOtpPaste}
              refs={otpRefs}
            />

            <div className="otp-note">{otpNote}</div>
            <div className={`otp-feedback ${otpError ? "error" : otpSuccess ? "success" : ""}`}>
              {otpError || otpSuccess}
            </div>

            {!isLoggedIn && canContinue && (
              <button
                type="button"
                className="primary-pill-btn"
                onClick={handleVerifyOtp}
                disabled={verifyPending}
              >
                {verifyPending ? "Verifying..." : "Continue"}
              </button>
            )}

            {isLoggedIn && (
              <button
                type="button"
                className="secondary-pill-btn"
                onClick={handleLogout}
                disabled={logoutPending}
              >
                {logoutPending ? "Logging out..." : "Logout"}
              </button>
            )}

            {!isLoggedIn && (
              <button type="button" className="secondary-pill-btn" onClick={handleBack}>
                Back
              </button>
            )}
          </section>
        </div>
      </div>
    </AuthScene>
  );
}

function SuperAdminLoginPage() {
  usePageMeta("Voxscribe SuperAdmin Login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("");
  const [otpVisible, setOtpVisible] = useState(false);
  const [otpChallengeId, setOtpChallengeId] = useState("");
  const [submitPending, setSubmitPending] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);

  const setStatusMessage = (text, type = "") => {
    setMessage(text);
    setMessageType(type);
  };

  const handleLogin = async (event) => {
    event.preventDefault();

    if (!email.trim() || !password.trim()) {
      setStatusMessage("SuperAdmin email and password are required.", "error");
      return;
    }

    setSubmitPending(true);
    setStatusMessage("Checking SuperAdmin account...", "success");

    try {
      const { response, data } = await apiJson("/api/superuser/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
        }),
      });

      if (!response.ok || !data.success) {
        setStatusMessage(data.message || "Unable to login SuperAdmin.", "error");
        return;
      }

      setOtpChallengeId(data.challengeId || "");
      setOtpVisible(true);
      setOtp("");
      setStatusMessage(data.message || "OTP has been sent to your email.", "success");
    } catch {
      setStatusMessage("Unable to reach server. Please try again.", "error");
    } finally {
      setSubmitPending(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!otpChallengeId) {
      setStatusMessage("Please login with email and password first.", "error");
      setOtpVisible(false);
      return;
    }

    if (!/^\d{6}$/.test(otp.trim())) {
      setStatusMessage("Please enter a valid 6 digit OTP.", "error");
      return;
    }

    setVerifyPending(true);
    setStatusMessage("Verifying SuperAdmin OTP...", "success");

    try {
      const { response, data } = await apiJson("/api/superuser/verify-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          challengeId: otpChallengeId,
          otp: otp.trim(),
        }),
      });

      if (!response.ok || !data.success) {
        setStatusMessage(data.message || "Unable to verify SuperAdmin OTP.", "error");
        return;
      }

      setStatusMessage(data.message || "SuperAdmin login successful.", "success");
      window.setTimeout(() => {
        window.location.assign("/admin");
      }, 400);
    } catch {
      setStatusMessage("Unable to reach server. Please try again.", "error");
    } finally {
      setVerifyPending(false);
    }
  };

  const handleBack = () => {
    setOtpVisible(false);
    setOtpChallengeId("");
    setOtp("");
    setMessage("");
    setMessageType("");
  };

  return (
    <div className="simple-auth-page">
      <div className="simple-auth-shell">
        <section className="simple-auth-card">
          <div className="simple-auth-top">
            <div className="eyebrow-badge">Super Admin</div>
            <div className="brand-badge">Voxscribe</div>
          </div>

          <h1>Login</h1>

          <div className={`status-message ${message ? "show" : ""} ${messageType}`}>{message}</div>

          {!otpVisible ? (
            <form onSubmit={handleLogin}>
              <div className="field-block">
                <label htmlFor="superadmin-email">Email</label>
                <input
                  id="superadmin-email"
                  type="email"
                  placeholder="superadmin@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <div className="field-block">
                <label htmlFor="superadmin-password">Password</label>
                <input
                  id="superadmin-password"
                  type="password"
                  placeholder="Enter password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              <button type="submit" className="flat-primary-btn" disabled={submitPending}>
                {submitPending ? "Checking..." : "Continue to OTP"}
              </button>
            </form>
          ) : (
            <div className="otp-panel">
              <div className="field-block">
                <label htmlFor="superadmin-otp">OTP Verification</label>
                <input
                  id="superadmin-otp"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="Enter 6 digit OTP"
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>

              <button type="button" className="flat-primary-btn" onClick={handleVerifyOtp} disabled={verifyPending}>
                {verifyPending ? "Verifying..." : "Verify OTP"}
              </button>

              <button type="button" className="flat-secondary-btn" onClick={handleBack}>
                Back
              </button>
            </div>
          )}

          <a className="footer-link" href="/">
            Go to Regular User Login
          </a>
        </section>
      </div>
    </div>
  );
}

function AdminPage() {
  usePageMeta("Voxscribe User Management");

  const [accessChecked, setAccessChecked] = useState(false);
  const [hasAccess, setHasAccess] = useState(false);
  const [accessDeniedMessage, setAccessDeniedMessage] = useState(
    "You do not have permission to view User Management."
  );
  const [users, setUsers] = useState([]);
  const [tableStatus, setTableStatus] = useState({ message: "", type: "info" });
  const [formStatus, setFormStatus] = useState({ message: "", type: "" });
  const [createUserChallengeId, setCreateUserChallengeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [formValues, setFormValues] = useState({
    name: "",
    email: "",
    password: "",
    allowDevices: "1",
    validDays: "30",
    status: "true",
    otp: "",
  });

  const dayOptions = useMemo(
    () =>
      Array.from({ length: 30 }, (_, index) => {
        const day = index + 1;
        return {
          value: String(day),
          label: `${day} day${day > 1 ? "s" : ""}`,
        };
      }),
    []
  );

  const deviceOptions = useMemo(
    () =>
      Array.from({ length: 5 }, (_, index) => {
        const device = index + 1;
        return {
          value: String(device),
          label: `${device} device${device > 1 ? "s" : ""}`,
        };
      }),
    []
  );

  const loadUsers = async () => {
    setTableStatus({ message: "Loading users...", type: "info" });

    try {
      const { response, data } = await apiJson("/api/users");

      if (!response.ok || !data.success) {
        if (response.status === 401 || response.status === 403) {
          setHasAccess(false);
          setAccessDeniedMessage(data.message || "Only the fixed SuperAdmin account can access this page.");
          setTableStatus({ message: "", type: "" });
          setUsers([]);
          return;
        }

        setTableStatus({ message: data.message || "Unable to load users.", type: "error" });
        setUsers([]);
        return;
      }

      const nextUsers = data.users || [];
      setUsers(nextUsers);
      setTableStatus({ message: `${nextUsers.length} user's`, type: "success" });
    } catch {
      setUsers([]);
      setTableStatus({ message: "Server error while loading users.", type: "error" });
    }
  };

  useEffect(() => {
    let active = true;

    const verifyAccess = async () => {
      try {
        const { response, data } = await apiJson("/api/superuser/session");

        if (!active) {
          return;
        }

        if (!response.ok || !data.success) {
          setHasAccess(false);
          setAccessDeniedMessage(data.message || "Only the fixed SuperAdmin account can access this page.");
          setAccessChecked(true);
          return;
        }

        setHasAccess(true);
        setAccessChecked(true);
        loadUsers();
      } catch {
        if (!active) {
          return;
        }

        setHasAccess(false);
        setAccessDeniedMessage("Unable to verify your SuperAdmin session. Please login again.");
        setAccessChecked(true);
      }
    };

    verifyAccess();

    const handlePageShow = (event) => {
      if (!event.persisted || !active) {
        return;
      }

      setAccessChecked(false);
      verifyAccess();
    };

    window.addEventListener("pageshow", handlePageShow);

    return () => {
      active = false;
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  const updateFormValue = (field, value) => {
    setFormValues((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSendOtp = async () => {
    if (!formValues.email.trim()) {
      setFormStatus({ message: "Enter the new user's email before sending OTP.", type: "error" });
      return;
    }

    setSendingOtp(true);
    setFormStatus({ message: `Sending OTP to ${formValues.email.trim()}...`, type: "info" });

    try {
      const { response, data } = await apiJson("/api/users/request-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: formValues.email.trim(),
        }),
      });

      if (!response.ok || !data.success) {
        setCreateUserChallengeId("");
        setFormStatus({ message: data.message || "Unable to send OTP.", type: "error" });
        return;
      }

      setCreateUserChallengeId(data.challengeId || "");
      setFormStatus({
        message: `OTP sent to ${formValues.email.trim()}. Enter it below to create the user.`,
        type: "success",
      });
    } catch {
      setCreateUserChallengeId("");
      setFormStatus({ message: "Server error while sending OTP.", type: "error" });
    } finally {
      setSendingOtp(false);
    }
  };

  const handleCreateUser = async (event) => {
    event.preventDefault();

    if (!formValues.name.trim() || !formValues.email.trim() || !formValues.password.trim()) {
      setFormStatus({ message: "Name, email, and password are required.", type: "error" });
      return;
    }

    if (!createUserChallengeId || !/^\d{6}$/.test(formValues.otp.trim())) {
      setFormStatus({ message: "Please send OTP and enter the valid 6 digit OTP.", type: "error" });
      return;
    }

    setSubmitting(true);
    setFormStatus({ message: "Creating user...", type: "info" });

    try {
      const { response, data } = await apiJson("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: formValues.name.trim(),
          email: formValues.email.trim(),
          password: formValues.password.trim(),
          allow_devices: formValues.allowDevices,
          valid_days: formValues.validDays,
          challenge_id: createUserChallengeId,
          otp: formValues.otp.trim(),
          is_active: formValues.status === "true",
        }),
      });

      if (!response.ok || !data.success) {
        setFormStatus({ message: data.message || "Unable to create user.", type: "error" });
        return;
      }

      setFormValues({
        name: "",
        email: "",
        password: "",
        allowDevices: "1",
        validDays: "30",
        status: "true",
        otp: "",
      });
      setCreateUserChallengeId("");
      setFormStatus({ message: `User ${data.user.name} created successfully.`, type: "success" });
      loadUsers();
    } catch {
      setFormStatus({ message: "Server error while creating user.", type: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleUserAction = async (action, user) => {
    if (action === "edit") {
      const currentStatus = user.is_active ? "active" : "inactive";
      const nextStatus = user.is_active ? "inactive" : "active";
      const isActive = !user.is_active;
      let validDays = String(user.valid_days || 30);

      if (isActive) {
        const validDaysInput = window.prompt(`Enter valid days for ${user.email} (1 to 30):`, validDays);

        if (validDaysInput === null) {
          return;
        }

        const parsedDays = Number.parseInt(validDaysInput.trim(), 10);

        if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 30) {
          setTableStatus({ message: "Valid days must be between 1 and 30.", type: "error" });
          return;
        }

        validDays = String(parsedDays);
      }

      const confirmed = window.confirm(`Change ${user.email} from ${currentStatus} to ${nextStatus}?`);

      if (!confirmed) {
        return;
      }

      setTableStatus({ message: `Changing ${user.email} to ${nextStatus}...`, type: "info" });

      try {
        const { response, data } = await apiJson(`/api/users/${user.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: user.email,
            valid_days: validDays,
            is_active: isActive,
          }),
        });

        if (!response.ok || !data.success) {
          setTableStatus({ message: data.message || "Unable to update user.", type: "error" });
          return;
        }

        setTableStatus({ message: `${data.user.email} is now ${nextStatus}.`, type: "success" });
        loadUsers();
      } catch {
        setTableStatus({ message: "Server error while updating user.", type: "error" });
      }

      return;
    }

    if (action === "password") {
      const newPassword = window.prompt(`Enter a new password for ${user.email}:`);

      if (newPassword === null) {
        return;
      }

      if (!newPassword.trim()) {
        setTableStatus({ message: "Password cannot be empty.", type: "error" });
        return;
      }

      setTableStatus({ message: `Resetting password for ${user.email}...`, type: "info" });

      try {
        const { response, data } = await apiJson(`/api/users/${user.id}/password`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            password: newPassword.trim(),
          }),
        });

        if (!response.ok || !data.success) {
          setTableStatus({ message: data.message || "Unable to reset password.", type: "error" });
          return;
        }

        setTableStatus({ message: `Password reset for ${data.user.email}.`, type: "success" });
      } catch {
        setTableStatus({ message: "Server error while resetting password.", type: "error" });
      }

      return;
    }

    if (action === "delete") {
      const confirmed = window.confirm(`Delete user ${user.email}?`);

      if (!confirmed) {
        return;
      }

      setTableStatus({ message: `Deleting ${user.email}...`, type: "info" });

      try {
        const { response, data } = await apiJson(`/api/users/${user.id}`, {
          method: "DELETE",
        });

        if (!response.ok || !data.success) {
          setTableStatus({ message: data.message || "Unable to delete user.", type: "error" });
          return;
        }

        setTableStatus({ message: `Deleted ${user.email}.`, type: "success" });
        loadUsers();
      } catch {
        setTableStatus({ message: "Server error while deleting user.", type: "error" });
      }
    }
  };

  const handleSuperAdminLogout = async () => {
    setLoggingOut(true);

    try {
      await apiJson("/api/superuser/logout", {
        method: "POST",
      });
    } finally {
      window.location.assign("/superadmin-login");
    }
  };

  if (!accessChecked) {
    return (
      <div className="admin-page">
        <div className="admin-shell">
          <div className="panel-card access-card">
            <h2>Checking access...</h2>
            <p>Please wait while your SuperAdmin session is verified.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="admin-page">
        <div className="admin-shell">
          <section className="panel-card access-card">
            <h2>SuperAdmin Access Required</h2>
            <p>{accessDeniedMessage}</p>
            <button type="button" className="admin-primary-btn" onClick={() => window.location.assign("/superadmin-login")}>
              Go to SuperAdmin Login
            </button>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <div className="admin-shell">
        <header className="admin-hero">
          <div>
            <h1>User Management</h1>
            <p>
              Only the fixed SuperAdmin account can create users, reset passwords, activate or deactivate
              accounts, and remove users from the database.
            </p>
          </div>

          <div className="hero-actions">
            <button type="button" className="admin-ghost-btn action-btn" onClick={handleSuperAdminLogout} disabled={loggingOut}>
              {loggingOut ? "Logging out..." : "Logout"}
            </button>
          </div>
        </header>

        <div className="admin-layout">
          <section className="panel-card add-user-panel">
            <h2>Add User</h2>
            <div className={`status-line ${formStatus.type}`}>{formStatus.message}</div>

            <form className="admin-form-grid" onSubmit={handleCreateUser}>
              <div>
                <label htmlFor="new-name">Name</label>
                <input
                  id="new-name"
                  type="text"
                  placeholder="Enter full name"
                  value={formValues.name}
                  onChange={(event) => updateFormValue("name", event.target.value)}
                />
              </div>

              <div>
                <label htmlFor="new-email">Email</label>
                <input
                  id="new-email"
                  type="email"
                  placeholder="user@example.com"
                  value={formValues.email}
                  onChange={(event) => updateFormValue("email", event.target.value)}
                />
              </div>

              <div>
                <label htmlFor="new-password">Password</label>
                <input
                  id="new-password"
                  type="password"
                  placeholder="Enter password"
                  value={formValues.password}
                  onChange={(event) => updateFormValue("password", event.target.value)}
                />
              </div>

              <div>
                <label htmlFor="allow-devices">Allow Devices</label>
                <select
                  id="allow-devices"
                  value={formValues.allowDevices}
                  onChange={(event) => updateFormValue("allowDevices", event.target.value)}
                >
                  {deviceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="valid-days">Valid For Days</label>
                <select
                  id="valid-days"
                  value={formValues.validDays}
                  onChange={(event) => updateFormValue("validDays", event.target.value)}
                >
                  {dayOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="new-status">Status</label>
                <select
                  id="new-status"
                  value={formValues.status}
                  onChange={(event) => updateFormValue("status", event.target.value)}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </div>

              <div>
                <label htmlFor="email-otp">Email OTP</label>
                <input
                  id="email-otp"
                  type="text"
                  maxLength={6}
                  inputMode="numeric"
                  placeholder="Enter 6 digit OTP"
                  value={formValues.otp}
                  onChange={(event) => updateFormValue("otp", event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>

              <button type="button" className="admin-ghost-btn" onClick={handleSendOtp} disabled={sendingOtp}>
                {sendingOtp ? "Sending OTP..." : "Send OTP"}
              </button>

              <button type="submit" className="admin-primary-btn" disabled={submitting}>
                {submitting ? "Creating User..." : "Create User"}
              </button>
            </form>
          </section>

          <section className="panel-card users-table-panel">
            <h2>Existing Users</h2>
            <p className="panel-copy">
              You can reset passwords, rename emails, activate or deactivate accounts, and permanently remove
              records.
            </p>
            <div className={`status-line ${tableStatus.type}`}>{tableStatus.message}</div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Created At</th>
                    <th>Allow Devices</th>
                    <th>Active Sessions</th>
                    <th>Valid Days</th>
                    <th>Login Count</th>
                    <th>Expires At</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>{user.name || "-"}</td>
                      <td>{user.email}</td>
                      <td>{formatDateTime(user.created_at)}</td>
                      <td>{user.allow_devices || "-"}</td>
                      <td>{Number.isFinite(Number(user.active_sessions)) ? Number(user.active_sessions) : 0}</td>
                      <td>{user.valid_days || "-"}</td>
                      <td>{Number.isFinite(Number(user.login_count)) ? Number(user.login_count) : 0}</td>
                      <td>{formatDateTime(user.expires_at)}</td>
                      <td>
                        <span className={`table-badge ${user.is_active ? "active" : "inactive"}`}>
                          {user.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <div className="action-group">
                          <button type="button" className="action-btn" onClick={() => handleUserAction("edit", user)}>
                            {user.is_active ? "Set Inactive" : "Set Active"}
                          </button>
                          <button
                            type="button"
                            className="action-btn warn"
                            onClick={() => handleUserAction("password", user)}
                          >
                            Reset Password
                          </button>
                          <button
                            type="button"
                            className="action-btn danger"
                            onClick={() => handleUserAction("delete", user)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!users.length && <div className="empty-state">No users found.</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

export default App;
