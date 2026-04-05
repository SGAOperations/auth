"use client";
import { useState, useEffect } from "react";

interface Props {
  onResend: () => void;
}

export function OtpForm({ onResend }: Props) {
  const [otp, setOtp] = useState("");
  const [cooldown, setCooldown] = useState(15);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function handleSubmit(e: React.SubmitEvent) {
    e.preventDefault();
  }

  function handleResend() {
    onResend();
    setCooldown(15);
  }

  return (
    <form onSubmit={handleSubmit} className="w-125 bg-white flex flex-col items-center justify-center p-8 text-xl rounded-4xl shadow-lg">
      <input
        className="w-full p-4 m-4 bg-gray-200 rounded-lg tracking-widest text-center"
        type="text"
        placeholder="XXXXXX"
        maxLength={6}
        value={otp}
        onChange={(e) => setOtp(e.target.value)}
        required
      />
      <button
        className="w-80 p-2 pl-4 pr-4 m-4 rounded-4xl"
        type="submit"
      >
        Verify Code
      </button>
      <button
        type="button"
        onClick={handleResend}
        disabled={cooldown > 0}
        className="text-sm text-gray-400 disabled:opacity-50"
      >
        {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
      </button>
    </form>
  );
}