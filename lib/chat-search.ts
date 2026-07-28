export type ChatSearchResult = {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
};

export type ChatSearchResponse = {
  conversations: ChatSearchResult[];
};

export const CHAT_SEARCH_MAX_QUERY_LENGTH = 200;
