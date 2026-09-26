import React from "react";
import Parties from "./pages/Parties.jsx";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";

import { AuthProvider } from "./context/AuthContext.jsx";
import { ClientProvider } from "./context/ClientContext.jsx";
import { ShiftProvider } from "./context/ShiftContext.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ClientProvider>
          <ShiftProvider>
            <App />
          </ShiftProvider>
        </ClientProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
