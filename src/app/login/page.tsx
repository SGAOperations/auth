"use client";
import Image from "next/image";
import { useState } from "react";
import { EmailForm } from "./EmailForm";
import { OtpForm } from "./OtpForm";

type Step = "email" | "otp";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("email");

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-red-200">
      <div className="flex flex-col items-center justify-center">
        <Image className="m-8" src="/SGA_logo.png" alt="Logo" width={350} height={150} style={{ height: "auto" }} loading="eager" />
        <div className="flex flex-col items-center justify-center pt-4">
          <h1 className="font-bold text-4xl m-8">Login</h1>
          {step === "email" ? (
            <EmailForm onNext={() => setStep("otp")} />
          ) : (
            <OtpForm onResend={() => {}} />
          )}
        </div>
      </div>
    </main>
  );
}