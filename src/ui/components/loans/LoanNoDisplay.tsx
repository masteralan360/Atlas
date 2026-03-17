import { cn } from "@/lib/utils";

interface LoanNoDisplayProps {
  loanNo: string;
  className?: string;
  suffixClassName?: string;
  plain?: boolean;
}

export function LoanNoDisplay({ loanNo, className, suffixClassName, plain }: LoanNoDisplayProps) {
  if (!loanNo) return null;

  // Regex to split base loan number and the trailing numeric suffix (e.g. -1, -2)
  const match = loanNo.match(/^(.*?)(\-\d+)?$/);
  
  if (!match) return <span className={className}>{loanNo}</span>;

  const base = match[1];
  const suffix = match[2];

  return (
    <span className={cn("font-medium", className)}>
      {base}
      {suffix && (
        <span className={cn(
          "font-bold ml-0.5", 
          plain ? "text-inherit" : "text-primary",
          suffixClassName
        )}>
          {suffix}
        </span>
      )}
    </span>
  );
}
