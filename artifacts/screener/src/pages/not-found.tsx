import { Card, CardContent } from '@/components/ui/card';
import { AlertCircle, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLocation } from 'wouter';

export default function NotFound() {
  const [_, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0 opacity-20 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
      </div>
      <Card className="w-full max-w-md border-border bg-muted/40 dark:bg-black/40 shadow-none backdrop-blur z-10 rounded-none relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-down/50" />
        <CardContent className="p-8 flex flex-col items-center text-center">
          <Terminal className="h-12 w-12 text-muted-foreground mb-6 opacity-50" />
          
          <h1 className="text-xl font-mono font-bold text-foreground uppercase tracking-widest mb-2">
            System Error 404
          </h1>

          <p className="text-sm text-muted-foreground font-mono mb-8">
            Path not recognized by routing engine.
          </p>
          
          <Button 
            onClick={() => setLocation('/')}
            className="w-full font-mono uppercase tracking-wider rounded-none"
            variant="outline"
          >
            Return to Root
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}