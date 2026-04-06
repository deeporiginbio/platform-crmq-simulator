'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <h2 style={{ color: '#D93E39' }}>Something went wrong</h2>
      <pre style={{ fontSize: 12, color: '#6B7280', whiteSpace: 'pre-wrap', maxWidth: 600, margin: '16px auto' }}>
        {error.message}
      </pre>
      <button
        onClick={reset}
        style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #D2D5DB', cursor: 'pointer', background: '#fff' }}
      >
        Try again
      </button>
    </div>
  );
}
