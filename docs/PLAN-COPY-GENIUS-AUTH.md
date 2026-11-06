# Cópia persistente e interrupções Genius

1. [concluído] Confirmar versão ativa, investigar clipboard e erro de autenticação exibido na captura.
2. [concluído] Corrigir causas confirmadas e validar regressões.
3. [concluído] Validar pacote, registrar entrega, commit/push main e instalar no development.

Aceite: cópia funciona sem trocar sessão; autenticação recuperável não encerra turnos indevidamente. Preservar sessões e alterações paralelas. Não expor credenciais nos logs. Evidência inicial: captura informa autenticação Sufficit expirada/revogada.

Diagnóstico confirmado: versão 2026.1105.1 ativa. Clipboard reportava sucesso apesar de execCommand retornar false (regressão reproduzida). Logs do Symposium de 2026-11-06 21:56Z e 22:01Z mostram Identity HTTP 400 invalid_grant: refresh token não é mais válido; Genius não possui enrollment próprio e usa esse login compartilhado, conforme contrato suportado. Ausência de enrollment próprio não é falha por si só.

4. [aguardando usuário] Reautenticar via Symposium: Login (Sufficit) e confirmar retomada do Genius. Não é possível renovar um refresh token revogado sem interação do titular.
