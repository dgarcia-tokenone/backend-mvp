const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

// Nova vers�o - fun��o p�blica
// Inicializa o SDK do Admin do Firebase
// O ambiente do Cloud Functions fornece as credenciais automaticamente
admin.initializeApp();

/**
 * Cloud Function que calcula e atualiza o valor di�rio de um token.
 * Recebe o 'tokenSymbol' via requisi��o POST.
 */
functions.http('calculateTokenDailyValue', async (req, res) => {
    // Valida o m�todo da requisi��o: aceita apenas POST.
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed. This function only accepts POST requests.');
    }

    // Extrai o 'tokenSymbol' do corpo da requisi��o.
    const { tokenSymbol } = req.body;

    // Valida se o 'tokenSymbol' foi fornecido.
    if (!tokenSymbol) {
        return res.status(400).send('Missing tokenSymbol in request body. Please provide a tokenSymbol (e.g., {"tokenSymbol": "ISI02"}).');
    }

    try {
        const db = admin.firestore();

        // Busca o documento da cole��o 'offers' pelo campo 'symbol'.
        const offersRef = db.collection('offers');
        const querySnapshot = await offersRef.where('symbol', '==', tokenSymbol).limit(1).get();

        // Se a oferta n�o for encontrada, retorna 404.
        if (querySnapshot.empty) {
            return res.status(404).send(`Offer with symbol "${tokenSymbol}" not found.`);
        }

        const offerDoc = querySnapshot.docs[0];
        const offerData = offerDoc.data();

        const { futureValue, originalPrice, totalInstallments, startProfitabilityDate } = offerData;

        // Valida se todos os campos necess�rios existem nos dados da oferta.
        if (futureValue === undefined || originalPrice === undefined || totalInstallments === undefined || startProfitabilityDate === undefined) {
            return res.status(400).send('Missing one or more required fields (futureValue, originalPrice, totalInstallments, startProfitabilityDate) in offer data.');
        }

        // Converte 'startProfitabilityDate' para um objeto Date.
        let startDate;
        if (startProfitabilityDate instanceof admin.firestore.Timestamp) {
            startDate = startProfitabilityDate.toDate();
        } else if (typeof startProfitabilityDate === 'string') {
            startDate = new Date(startProfitabilityDate);
        } else {
            return res.status(400).send('Invalid startProfitabilityDate format. Expected Firestore Timestamp or ISO string.');
        }

        const today = new Date();
        // Zera horas, minutos, segundos e milissegundos para compara��es de data precisas.
        today.setHours(0, 0, 0, 0);
        startDate.setHours(0, 0, 0, 0);

        // 1. Calcula a Renda Total: (futureValue - originalPrice)
        const totalIncome = futureValue - originalPrice;

        // 2. Calcula a Renda Mensal: (Renda Total / totalInstallments)
        const monthlyIncome = totalIncome / totalInstallments;

        // 3. Calcula a Renda Di�ria e o Valor Atual do Token
        const maturityDay = startDate.getDate();

        // Determina a �ltima data de vencimento (parcela) no ou antes do dia de hoje.
        let lastMaturityDate = new Date(today.getFullYear(), today.getMonth(), maturityDay);
        // Ajusta para o m�s anterior se o dia de vencimento for no futuro neste m�s.
        if (lastMaturityDate.getTime() > today.getTime()) {
            lastMaturityDate.setMonth(lastMaturityDate.getMonth() - 1);
        }
        // Garante que a data n�o ultrapasse o �ltimo dia do m�s, se o maturityDay for maior.
        if (lastMaturityDate.getDate() !== maturityDay && maturityDay > 28) {
            lastMaturityDate = new Date(lastMaturityDate.getFullYear(), lastMaturityDate.getMonth() + 1, 0); // �ltimo dia do m�s anterior
        }
        lastMaturityDate.setHours(0, 0, 0, 0); // Zera horas para compara��o de datas.

        // Determina a pr�xima data de vencimento ap�s a �ltima data de vencimento.
        let nextMaturityDate = new Date(lastMaturityDate.getFullYear(), lastMaturityDate.getMonth() + 1, maturityDay);
        // Ajusta para meses com menos dias que o 'maturityDay'.
        if (nextMaturityDate.getDate() !== maturityDay) {
            nextMaturityDate = new Date(nextMaturityDate.getFullYear(), nextMaturityDate.getMonth(), 0); // �ltimo dia do m�s
        }
        nextMaturityDate.setHours(0, 0, 0, 0); // Zera horas para compara��o de datas.

        // LOGGING AQUI: Registrando as datas para depura��o
        console.log(`[${tokenSymbol}] Datas de c�lculo: `);
        console.log(`[${tokenSymbol}] Data de Hoje: ${today.toISOString().split('T')[0]}`);
        console.log(`[${tokenSymbol}] �ltimo Vencimento: ${lastMaturityDate.toISOString().split('T')[0]}`);
        console.log(`[${tokenSymbol}] Pr�ximo Vencimento: ${nextMaturityDate.toISOString().split('T')[0]}`);


        let dailyIncome = 0;
        let daysPassed = 0;
        let daysInPeriod = 0;

        // Se o processamento for no dia do vencimento, a renda di�ria � zero e o 'initialPrice' volta a ser 'originalPrice'.
        if (today.getTime() === lastMaturityDate.getTime()) {
            dailyIncome = 0;
            daysPassed = 0;
            console.log(`[${tokenSymbol}] Processando no dia do vencimento. Renda di�ria definida como 0.`);
        } else {
            // Calcula a quantidade de dias no per�odo entre vencimentos.
            daysInPeriod = Math.round((nextMaturityDate.getTime() - lastMaturityDate.getTime()) / (1000 * 60 * 60 * 24));
            console.log(`[${tokenSymbol}] Dias calculados para o per�odo de vencimento: ${daysInPeriod}`);
            dailyIncome = monthlyIncome / daysInPeriod;

            // Calcula quantos dias decorreram desde o �ltimo vencimento.
            daysPassed = Math.round((today.getTime() - lastMaturityDate.getTime()) / (1000 * 60 * 60 * 24));
            if (daysPassed < 0) daysPassed = 0; // Garante que n�o haja dias passados negativos.
            console.log(`[${tokenSymbol}] Dias decorridos desde o �ltimo vencimento: ${daysPassed}`);
        }

        // Calcula a Renda Acumulada e o Novo Valor Atual do Token.
        const accruedIncome = daysPassed * dailyIncome;
        let currentTokenValue = originalPrice + accruedIncome;

        // Arredonda o currentTokenValue para duas casas decimais
        currentTokenValue = parseFloat(currentTokenValue.toFixed(2));
        console.log(`[${tokenSymbol}] Valor Atual do Token Calculado: ${currentTokenValue}`);


        // 4. Atualiza os campos 'initialPrice' e 'minInvestiment' no documento do Firestore.
        await offerDoc.ref.update({
            initialPrice: currentTokenValue,
            minInvestiment: currentTokenValue // CORRE��O AQUI: minInvestiment
        });
        console.log(`[${tokenSymbol}] Campos initialPrice e minInvestiment atualizados no Firestore.`);

        // Retorna uma resposta JSON concisa indicando o sucesso e os novos valores.
        return res.status(200).json({
            message: 'Token values calculated and updated successfully.',
            tokenSymbol: tokenSymbol,
            updatedInitialPrice: currentTokenValue,
            updatedMinInvestiment: currentTokenValue, // CORRE��O AQUI: minInvestiment na resposta
            dailyIncomeCalculated: dailyIncome,
            daysPassedSinceLastMaturity: daysPassed,
            daysInPeriodCalculated: daysInPeriod
        });

    } catch (error) {
        console.error('Error calculating token daily value:', error);
        return res.status(500).send(`Internal Server Error: ${error.message}`);
    }
});