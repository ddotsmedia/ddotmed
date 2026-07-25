import clsx from 'clsx';

export interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  fullScreen?: boolean;
  className?: string;
}

const SIZE = { sm: 'size-4 border-2', md: 'size-8 border-[3px]', lg: 'size-12 border-4' } as const;

export function LoadingSpinner({
  size = 'md',
  label = 'Loading…',
  fullScreen = false,
  className,
}: LoadingSpinnerProps) {
  const spinner = (
    <span
      role="status"
      aria-label={label}
      className={clsx(
        'inline-block animate-spin rounded-full border-slate-300 border-t-sky-600',
        SIZE[size],
        className,
      )}
      data-testid="loading-spinner"
    />
  );
  if (!fullScreen) return spinner;
  return (
    <div className="flex min-h-[50vh] w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        {spinner}
        <p className="text-sm text-slate-600 dark:text-slate-300">{label}</p>
      </div>
    </div>
  );
}
