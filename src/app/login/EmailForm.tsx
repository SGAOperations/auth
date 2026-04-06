"use client";
import { useState } from "react";

interface Props {
    onNext: () => void;
}

export function EmailForm({ onNext }: Props) {
    const [email, setEmail] = useState("");

    function handleSubmit(e: React.SubmitEvent) {
    e.preventDefault();
    onNext();
    }

    return (
    <form onSubmit={handleSubmit} className="w-125 bg-white flex flex-col items-center justify-center p-8 text-xl rounded-4xl shadow-lg">
        <input
        className="w-full p-4 m-4 bg-gray-200 rounded-lg"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        />
        <button
        className="w-80 p-2 pl-4 pr-4 m-4 rounded-4xl"
        type="submit"
        >
        Send Code
        </button>
    </form>
    );
}