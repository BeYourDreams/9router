"use client";

import { useEffect, useState } from "react";
import { translate } from "@/i18n/runtime";

export default function WebLoginCapture() {
  const [status, setStatus] = useState("waiting"); // waiting | success | error
  const [message, setMessage] = useState("");

  useEffect(() => {
    const channel = new BroadcastChannel("ninerouter:web-login-token");
    const providerId = new URLSearchParams(window.location.search).get("provider");

    const handleMessage = (event) => {
      if (!event.data || event.data.providerId !== providerId) return;
      const { token, error } = event.data;
      if (error) {
        setStatus("error");
        setMessage(error);
        return;
      }
      if (token) {
        setStatus("success");
        setMessage(translate("Token captured"));
        // Send token to parent (dashboard) via postMessage
        if (window.opener) {
          window.opener.postMessage(
            { type: "NINEROUTER_WEB_LOGIN_TOKEN", providerId, token },
            window.location.origin
          );
        }
        // Close popup after short delay
        setTimeout(() => window.close(), 1000);
      }
    };

    channel.addEventListener("message", handleMessage);
    return () => channel.removeEventListener("message", handleMessage);
  }, []);

  if (status === "success") {
    return (
      <div style={styles.container}>
        <div style={styles.icon}>✓</div>
        <p>{message}</p>
        <p style={styles.subtitle}>{translate("Closing...")}</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={styles.container}>
        <div style={{ ...styles.icon, background: "#ef4444" }}>✕</div>
        <p>{message || translate("Failed to capture token")}</p>
        <button onClick={() => window.close()} style={styles.button}>
          {translate("Close")}
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.spinner} />
      <p>{translate("Waiting for token...")}</p>
      <p style={styles.subtitle}>{translate("Click the bookmarklet on the provider page")}</p>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    fontFamily: "system-ui, sans-serif",
    background: "#fafafa",
    color: "#111",
    gap: "16px",
  },
  icon: {
    width: "64px",
    height: "64px",
    borderRadius: "50%",
    background: "#22c55e",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "32px",
    color: "white",
  },
  spinner: {
    width: "40px",
    height: "40px",
    border: "3px solid #e5e7eb",
    borderTopColor: "#3b82f6",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  subtitle: {
    color: "#6b7280",
    fontSize: "14px",
  },
  button: {
    marginTop: "16px",
    padding: "8px 24px",
    background: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  },
};