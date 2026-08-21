"use client";

import { useState } from "react";
import HandwritingUpload from "@/components/HandwritingUpload";
import VoiceUpload from "@/components/VoiceUpload";
import TextInput from "@/components/TextInput";
import {
  applyValidationResult,
  initialLockState,
  isLocked,
  resetLock,
  type InputType,
} from "@/lib/locking";

export default function Home() {
  const [lockState, setLockState] = useState(initialLockState);

  function handleResult(type: InputType, status: "VALID" | "INVALID") {
    setLockState((prev) => applyValidationResult(prev, type, status));
  }

  return (
    <main className="min-h-screen py-10 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Extraction Accuracy Test
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Handwritten OCR (GPT-5 Vision) · Voice transcription (AssemblyAI) ·
            Typed text — accuracy testing only.
          </p>
        </div>

        {lockState.acceptedType && (
          <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 text-sm font-medium">
            One valid input has been accepted. Other input methods are now
            locked.
            <button
              onClick={() => setLockState(resetLock())}
              className="ml-3 underline text-green-700"
            >
              Reset
            </button>
          </div>
        )}

        <div className="grid gap-6">
          <HandwritingUpload
            locked={isLocked(lockState, "HANDWRITTEN")}
            onResult={(status) => handleResult("HANDWRITTEN", status)}
          />
          <VoiceUpload
            locked={isLocked(lockState, "VOICE")}
            onResult={(status) => handleResult("VOICE", status)}
          />
          <TextInput
            locked={isLocked(lockState, "TEXT")}
            onResult={(status) => handleResult("TEXT", status)}
          />
        </div>
      </div>
    </main>
  );
}
