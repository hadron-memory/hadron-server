export enum Role {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  CONTRIBUTOR = 'CONTRIBUTOR',
  READER = 'READER',
}

export enum StationType {
  WORKSTATION = 'WORKSTATION',
  AGENT = 'AGENT',
  AUTOMATION = 'AUTOMATION',
  CLOUD = 'CLOUD',
  IOT = 'IOT',
}

export enum SubscriptionType {
  READ_ONLY = 'READ_ONLY',
  READ_WRITE = 'READ_WRITE',
}

export enum SessionType {
  DEVELOPER = 'DEVELOPER',
  CHATBOT = 'CHATBOT',
  AUTOMATION = 'AUTOMATION',
  EDGE = 'EDGE',
}

export enum SyncStatus {
  PENDING = 'PENDING',
  SYNCING = 'SYNCING',
  OK = 'OK',
  ERROR = 'ERROR',
}

export enum IdentityProvider {
  GITHUB = 'GITHUB',
}

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export enum MemoryVisibility {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
  ORGANIZATION = 'ORGANIZATION',
}
