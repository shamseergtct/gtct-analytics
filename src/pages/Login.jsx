import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function Login() {
  const { login, register } = useAuth(); // ✅ only depend on real auth functions
  const nav = useNavigate();

  const [mode, setMode] = useState("login"); // login | register
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // ✅ local error (no dependency on AuthContext)
  const [authError, setAuthError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setAuthError("");

    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        if (!register) throw new Error("Registration is disabled.");
        await register(email, password);
      }

      nav("/dashboard", { replace: true });
    } catch (err) {
      setAuthError(err?.message || "Auth failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 p-6 shadow-lg border border-slate-800">
        <h1 className="text-2xl font-bold">GTCT Analytics</h1>
        <p className="mt-1 text-slate-300">
          {mode === "login" ? "Login to continue" : "Create your account"}
        </p>

        <form className="mt-6 space-y-3" onSubmit={submit}>
          <div>
            <label className="text-sm text-slate-300">Email</label>
            <input
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-500"
              placeholder="you@example.com"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="text-sm text-slate-300">Password</label>
            <input
              className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-500"
              placeholder="••••••••"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {authError ? (
            <div className="text-sm text-red-200 bg-red-950/40 border border-red-900 rounded-xl p-2">
              {authError}
            </div>
          ) : null}

          <button
            disabled={loading}
            className="w-full rounded-xl bg-white text-slate-950 font-semibold py-2 disabled:opacity-60 hover:opacity-90 transition"
          >
            {loading
              ? "Please wait…"
              : mode === "login"
              ? "Login"
              : "Create Account"}
          </button>
        </form>

        <div className="mt-4 text-sm text-slate-300">
          {mode === "login" ? (
            <>
              Don’t have an account?{" "}
              <button
                className="underline hover:text-white"
                onClick={() => {
                  setAuthError("");
                  setMode("register");
                }}
                type="button"
              >
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                className="underline hover:text-white"
                onClick={() => {
                  setAuthError("");
                  setMode("login");
                }}
                type="button"
              >
                Login
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
