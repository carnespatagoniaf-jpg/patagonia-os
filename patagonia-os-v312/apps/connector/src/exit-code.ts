// Con qué código sale el proceso al apagarse. Importa para WinSW: con 0 le avisa a Windows "me paré bien" y Windows NO
// lo vuelve a levantar; con otro código, Windows aplica el reinicio ante caídas (5 s, 15 s, 60 s). Una falla inesperada
// (uncaughtException) tiene que salir con error aunque el apagado prolijo haya andado, o el servicio queda parado.

export type ShutdownReason = "SIGINT" | "SIGTERM" | "SIGBREAK" | "uncaughtException";

export function shutdownExitCode(reason: ShutdownReason, stoppedCleanly: boolean): number {
  if (reason === "uncaughtException") return 1;
  return stoppedCleanly ? 0 : 1;
}
