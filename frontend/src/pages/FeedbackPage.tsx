import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorBanner } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { api } from "@/services/api";

export function FeedbackPage() {
  const [category, setCategory] = useState("idea");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const submit = useMutation({
    mutationFn: () => api("/feedback", { method: "POST", json: {
      category, message, ...(email ? { reply_email: email } : {}) } }),
    onSuccess: () => { setDone(true); setMessage(""); setEmail(""); },
  });
  const send = (e: FormEvent) => { e.preventDefault(); submit.mutate(); };
  return (
    <div className="mx-auto max-w-2xl p-5">
      <Card>
        <CardHeader title="Soft-launch feedback" description="Tell us what is broken, confusing or missing. No account required." />
        <CardBody>
          {done ? (
            <div className="space-y-3 text-sm" data-testid="feedback-thanks">
              <p className="font-medium text-positive">Thank you — your feedback was recorded.</p>
              <p className="text-muted">The team reviews submissions during the soft launch. Do not include account credentials or personal financial data.</p>
              <button className="underline underline-offset-2" onClick={() => setDone(false)}>Send another</button>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={send} data-testid="feedback-form">
              <ErrorBanner error={submit.error} />
              <Field label="Category" htmlFor="feedback-category">
                <Select id="feedback-category" aria-label="Feedback category" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="idea">Idea</option>
                  <option value="bug">Something is broken</option>
                  <option value="data_issue">Market data issue</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Message" htmlFor="feedback-message" hint="10–2000 characters. Please do not paste secrets or personal financial details.">
                <textarea id="feedback-message" aria-label="Feedback message" required minLength={10} maxLength={2000}
                  rows={6} value={message} onChange={(e) => setMessage(e.target.value)}
                  className="w-full rounded-md border border-border-strong bg-surface-2 p-3 text-sm text-fg placeholder:text-subtle focus:border-accent focus:outline-none" />
              </Field>
              <Field label="Reply email (optional)" htmlFor="feedback-email">
                <Input id="feedback-email" aria-label="Reply email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </Field>
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={submit.isPending || message.trim().length < 10}>Send feedback</Button>
                <Link className="text-xs underline underline-offset-2" to="/status">See public status</Link>
              </div>
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
