# Tempo Agenda — lembretes

Este repositório solicita ao GitHub Actions uma execução de cinco em cinco minutos para enviar lembretes da aplicação Tempo. O GitHub pode atrasar ou omitir execuções; este serviço não garante entrega ao minuto. Não ativa serviços pagos.

O agendador respeita as datas no fuso Europe/Lisbon, repetição diária/semanal/mensal e lembretes antes da meia-noite. Não envia lembretes de tarefas concluídas. Nas mudanças de hora, horas inexistentes avançam pela diferença de horário e horas repetidas são consideradas uma só vez.

As confirmações são gravadas depois de o Firebase aceitar a mensagem. Tentativas que falham podem voltar a executar, uma reserva temporária impede envios concorrentes e um token expirado não impede o envio para outros dispositivos. As mensagens usam uma etiqueta comum à aplicação para limitar notificações repetidas. Como o envio e a confirmação são serviços diferentes, uma interrupção entre ambos pode causar uma repetição; não há garantia de entrega exatamente uma vez.

Cada agenda guarda o último instante verificado para recuperar atrasos. A pesquisa recua no máximo 24 horas e ignora lembretes mais de 30 minutos depois do início do evento. Na primeira execução, procura apenas os 30 minutos anteriores. O GitHub desativa agendamentos em repositórios públicos após 60 dias sem atividade; é necessário reativá-los nesse caso.

Executar `npm test` valida os cenários de datas, recorrência, falha/repetição e concorrência sem ligação ao Firebase nem envio de notificações reais. O ficheiro `send-reminders.js` continua a ser autónomo para publicação.

A credencial do Firebase é armazenada exclusivamente no segredo `FIREBASE_SERVICE_ACCOUNT` do GitHub. Não deve ser adicionada a ficheiros nem partilhada.
