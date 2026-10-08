import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "../context/AuthContext.jsx";
import "../index.css";
import DeliveryApp from "./DeliveryApp.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <DeliveryApp />
    </AuthProvider>
  </React.StrictMode>
);

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/delivery-sw.js").catch((err) => {
      console.warn("Delivery SW registration failed:", err);
    });
  });
}
