const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');

// Nova versão - função pública
// Inicializa o SDK do Admin do Firebase
// O ambiente do Cloud Functions fornece as credenciais automaticamente
admin.initializeApp();

/**
 * Cloud Function que calcula e atualiza o valor diário de um token.
 * Recebe o 'tokenSymbol' via requisição POST.
 */
functions.http('calculateTokenDailyValue', async (req, res) => {
    // Valida o método da requisição: aceita apenas POST.
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed. This function only accepts POST requests.');
    }

    // Extrai o 'tokenSymbol' do corpo da requisição.
    const { tokenSymbol } = req.body;

    // Valida se o 'tokenSymbol' foi fornecido.
    if (!tokenSymbol) {
        return res.status(400).send('Missing tokenSymbol in request body. Please provide a tokenSymbol (e.g., {"tokenSymbol": "ISI02"}).');
    }

    try {
        const db = admin.firestore();

        // Busca o documento da coleção 'offers' pelo campo 'symbol'.
        const offersRef = db.collection('offers');
        const querySnapshot = await offersRef.where('symbol', '==', tokenSymbol).limit(1).get();

        // Se a oferta não for encontrada, retorna 404.
        if (querySnapshot.empty) {
            return res.status(404).send(`Offer with symbol "${tokenSymbol}" not found.`);
        }

        const offerDoc = querySnapshot.docs[0];
        const offerData = offerDoc.data();

        const { futureValue, originalPrice, totalInstallments, startProfitabilityDate } = offerData;

        // Valida se todos os campos necessários existem nos dados da oferta.
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
        // Zera horas, minutos, segundos e milissegundos para comparações de data precisas.
        today.setHours(0, 0, 0, 0);
        startDate.setHours(0, 0, 0, 0);

        // 1. Calcula a Renda Total: (futureValue - originalPrice)
        const totalIncome = futureValue - originalPrice;

        // 2. Calcula a Renda Mensal: (Renda Total / totalInstallments)
        const monthlyIncome = totalIncome / totalInstallments;

        // 3. Calcula a Renda Diária e o Valor Atual do Token
        const maturityDay = startDate.getDate();

        // Determina a última data de vencimento (parcela) no ou antes do dia de hoje.
        let lastMaturityDate = new Date(today.getFullYear(), today.getMonth(), maturityDay);
        // Ajusta para o mês anterior se o dia de vencimento for no futuro neste mês.
        if (lastMaturityDate.getTime() > today.getTime()) {
            lastMaturityDate.setMonth(lastMaturityDate.getMonth() - 1);
        }
        // Garante que a data não ultrapasse o último dia do mês, se o maturityDay for maior.
        if (lastMaturityDate.getDate() !== maturityDay && maturityDay > 28) {
            lastMaturityDate = new Date(lastMaturityDate.getFullYear(), lastMaturityDate.getMonth() + 1, 0); // Último dia do mês anterior
        }
        lastMaturityDate.setHours(0, 0, 0, 0); // Zera horas para comparação de datas.

        // Determina a próxima data de vencimento após a última data de vencimento.
        let nextMaturityDate = new Date(lastMaturityDate.getFullYear(), lastMaturityDate.getMonth() + 1, maturityDay);
        // Ajusta para meses com menos dias que o 'maturityDay'.
        if (nextMaturityDate.getDate() !== maturityDay) {
            nextMaturityDate = new Date(nextMaturityDate.getFullYear(), nextMaturityDate.getMonth(), 0); // Último dia do mês
        }
        nextMaturityDate.setHours(0, 0, 0, 0); // Zera horas para comparação de datas.

        // LOGGING AQUI: Registrando as datas para depuração
        console.log(`[${tokenSymbol}] Datas de cálculo: `);
        console.log(`[${tokenSymbol}] Data de Hoje: ${today.toISOString().split('T')[0]}`);
        console.log(`[${tokenSymbol}] Último Vencimento: ${lastMaturityDate.toISOString().split('T')[0]}`);
        console.log(`[${tokenSymbol}] Próximo Vencimento: ${nextMaturityDate.toISOString().split('T')[0]}`);


        let dailyIncome = 0;
        let daysPassed = 0;
        let daysInPeriod = 0;

        // Se o processamento for no dia do vencimento, a renda diária é zero e o 'initialPrice' volta a ser 'originalPrice'.
        if (today.getTime() === lastMaturityDate.getTime()) {
            dailyIncome = 0;
            daysPassed = 0;
            console.log(`[${tokenSymbol}] Processando no dia do vencimento. Renda diária definida como 0.`);
        } else {
            // Calcula a quantidade de dias no período entre vencimentos.
            daysInPeriod = Math.round((nextMaturityDate.getTime() - lastMaturityDate.getTime()) / (1000 * 60 * 60 * 24));
            console.log(`[${tokenSymbol}] Dias calculados para o período de vencimento: ${daysInPeriod}`);
            dailyIncome = monthlyIncome / daysInPeriod;

            // Calcula quantos dias decorreram desde o último vencimento.
            daysPassed = Math.round((today.getTime() - lastMaturityDate.getTime()) / (1000 * 60 * 60 * 24));
            if (daysPassed < 0) daysPassed = 0; // Garante que não haja dias passados negativos.
            console.log(`[${tokenSymbol}] Dias decorridos desde o último vencimento: ${daysPassed}`);
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
            minInvestiment: currentTokenValue // CORREÇÃO AQUI: minInvestiment
        });
        console.log(`[${tokenSymbol}] Campos initialPrice e minInvestiment atualizados no Firestore.`);

        // Retorna uma resposta JSON concisa indicando o sucesso e os novos valores.
        return res.status(200).json({
            message: 'Token values calculated and updated successfully.',
            tokenSymbol: tokenSymbol,
            updatedInitialPrice: currentTokenValue,
            updatedMinInvestiment: currentTokenValue, // CORREÇÃO AQUI: minInvestiment na resposta
            dailyIncomeCalculated: dailyIncome,
            daysPassedSinceLastMaturity: daysPassed,
            daysInPeriodCalculated: daysInPeriod
        });

    } catch (error) {
        console.error('Error calculating token daily value:', error);
        return res.status(500).send(`Internal Server Error: ${error.message}`);
    }
});