import type { ReactNode } from "react";
import { Video } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";

export function AnalysisDetailsLayout({video,children,className=""}:{video:ReactNode;children:ReactNode;className?:string}) {
  return <div className={`analysis-details-grid ${className}`}>
    <div className="analysis-details-video-column">{video}</div>
    <aside className="analysis-details-charts-column" aria-label="Gráficos e resultados da análise">{children}</aside>
  </div>;
}
export function DetailsVideoCard({children,description="Reprodução sincronizada com os resultados."}:{children:ReactNode;description?:string}) {
  return <Card className="details-video-card"><CardHeader><CardTitle className="details-card-title"><Video size={16}/>Vídeo da análise</CardTitle>
    <CardDescription>{description}</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>;
}
