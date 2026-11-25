using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace AIWorkerGateway.Windows
{
    public static class WindowlessProcess
    {
        internal static StreamWriter openLog(string logPath)
        {
            Encoding encoding = new UTF8Encoding(false);
            if (File.Exists(logPath))
            {
                using (var existing = File.Open(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    if (existing.ReadByte() == 0xFF && existing.ReadByte() == 0xFE)
                    {
                        encoding = Encoding.Unicode;
                    }
                }
            }

            var writer = new StreamWriter(logPath, true, encoding);
            writer.AutoFlush = true;
            return writer;
        }

        public static int run(string executable, string arguments, string workingDirectory, string logPath)
        {
            var startInfo = new ProcessStartInfo(executable, arguments)
            {
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using (var log = openLog(logPath))
            using (var process = new Process { StartInfo = startInfo })
            {
                var logLock = new object();
                DataReceivedEventHandler writeLine = delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    if (eventArgs.Data == null)
                    {
                        return;
                    }

                    lock (logLock)
                    {
                        log.WriteLine(eventArgs.Data);
                    }
                };
                process.OutputDataReceived += writeLine;
                process.ErrorDataReceived += writeLine;

                if (!process.Start())
                {
                    throw new InvalidOperationException("The Gateway child process did not start.");
                }

                process.StandardInput.Close();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();

                log.WriteLine("[{0:O}] Process exited with status {1}.", DateTime.UtcNow, process.ExitCode);
                return process.ExitCode;
            }
        }
    }

    internal static class WindowlessLauncher
    {
        private static string quotePowerShellLiteral(string value)
        {
            return "'" + value.Replace("'", "''") + "'";
        }

        private static string buildCommand(string[] args)
        {
            var command = new StringBuilder("$ErrorActionPreference = 'Stop'; & ");
            command.Append(quotePowerShellLiteral(args[1]));
            for (int index = 3; index < args.Length; index++)
            {
                command.Append(' ').Append(quotePowerShellLiteral(args[index]));
            }

            command.Append("; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }");
            return Convert.ToBase64String(Encoding.Unicode.GetBytes(command.ToString()));
        }

        public static int Main(string[] args)
        {
            if (args.Length < 3)
            {
                return 2;
            }

            string logPath = args[2];
            try
            {
                string launcherPath = typeof(WindowlessLauncher).Assembly.Location;
                Environment.SetEnvironmentVariable("AWG_WINDOWLESS_LAUNCHER", launcherPath);
                string arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + buildCommand(args);

                return WindowlessProcess.run(args[0], arguments, Path.GetDirectoryName(args[1]), logPath);
            }
            catch (Exception error)
            {
                using (var log = WindowlessProcess.openLog(logPath))
                {
                    log.WriteLine("[{0:O}] Startup failed: {1}", DateTime.UtcNow, error);
                }

                return 1;
            }
        }
    }
}
