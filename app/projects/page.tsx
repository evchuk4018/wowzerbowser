import type { Metadata } from "next";
import { ProjectPage } from "./project-page";

export const metadata: Metadata = { title: "Projects · Chat" };

export default function ProjectsPage() {
  return <ProjectPage />;
}
