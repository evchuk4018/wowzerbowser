import type { ChatProject, ChatProjectChat, ChatProjectFileMetadata } from "../../lib/chat-project-protocol";

export type Project = ChatProject;
export type ProjectChat = ChatProjectChat;
export type ProjectFile = ChatProjectFileMetadata;

export type ProjectDetail = {
  project: Project;
  chats: ProjectChat[];
  files: ProjectFile[];
};
