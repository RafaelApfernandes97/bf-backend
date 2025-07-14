#!/bin/bash

# Script de deploy para o backend
echo "🚀 Iniciando deploy do backend..."

# Configurações
IMAGE_NAME="backend-fotos"
TAG="latest"
REGISTRY="your-registry.com"  # Substitua pelo seu registry

# Build da imagem
echo "📦 Fazendo build da imagem..."
docker build -t $IMAGE_NAME:$TAG .

# Tag para o registry
echo "🏷️  Tagging imagem..."
docker tag $IMAGE_NAME:$TAG $REGISTRY/$IMAGE_NAME:$TAG

# Push para o registry
echo "⬆️  Fazendo push para o registry..."
docker push $REGISTRY/$IMAGE_NAME:$TAG

echo "✅ Deploy do backend concluído!"
echo "📋 Imagem: $REGISTRY/$IMAGE_NAME:$TAG" 